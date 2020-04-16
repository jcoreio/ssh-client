import { promisify } from 'es6-promisify'
import {
  Client as SSH2Client,
  ConnectConfig,
  ClientChannel as SSH2ClientChannel,
  SFTPWrapper,
} from 'ssh2'
import { VError } from 'verror'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger } = require('log4jcore')

const log = logger('ssh-client')

export type ExecResult = {
  code: number
  stdout: string
  stderr: string
}

export default class SSHClient {
  private readonly client: SSH2Client = new SSH2Client()
  private readonly config: ConnectConfig

  private connectStarted = false

  constructor(config: ConnectConfig) {
    this.config = config
  }

  connect(): Promise<void> {
    this.connectStarted = true
    return new Promise((resolve: () => void, reject: (err: Error) => void) => {
      const { client } = this
      // eslint-disable-next-line prefer-const
      let onReady: () => void | undefined
      const onError = (err: Error): void => {
        log.debug('connect() got error:', err)
        if (onReady) client.removeListener('ready', onReady)
        reject(new VError(err, 'SSH connect failed'))
      }
      onReady = (): void => {
        log.debug('connect() got ready event')
        client.removeListener('error', onError)
        resolve()
      }
      client.once('error', onError)
      client.once('ready', onReady)
      client.connect(this.config)
    })
  }

  private async connectIfNeeded(): Promise<void> {
    if (!this.connectStarted) await this.connect()
  }

  close(): void {
    this.client.end()
  }

  async exec(
    cmd: string,
    {
      stdin,
      timeout,
      throwOnNonZero,
    }: {
      stdin?: string | Buffer | undefined
      timeout?: number | undefined
      throwOnNonZero?: boolean | undefined
    } = {}
  ): Promise<ExecResult> {
    await this.connectIfNeeded()
    const { client } = this
    return await new Promise(
      (resolve: (result: ExecResult) => void, reject: (err: Error) => void) => {
        let stdout = ''
        let stderr = ''
        let settled = false
        let timeoutId = timeout
          ? setTimeout(() => {
              if (!settled) {
                settled = true
                const msg = `exec timeout of ${timeout} ms expired`
                log.debug(msg)
                reject(new Error(msg))
              }
            }, timeout)
          : undefined
        client.exec(
          cmd,
          (err: Error | undefined, channel: SSH2ClientChannel) => {
            channel.stderr.setEncoding('utf-8')
            channel.stdout.on('data', (data: string) => {
              stdout += data
            })
            channel.stderr.on('data', (data: string) => {
              stderr += data
            })
            let stdinDone = !stdin
            channel.on('exit', (code: number | null) => {
              if (timeoutId) {
                clearTimeout(timeoutId)
                timeoutId = undefined
              }
              const resultInfo = (): string =>
                `code: ${code}\nstderr: "${stderr}"\nstdout: "${stdout}"`
              if (!settled) {
                settled = true
                if (!stdinDone) {
                  const msg = `ssh command finished before stdin was written: ${resultInfo()}`
                  log.debug(msg)
                  reject(new Error(msg))
                } else {
                  log.debug(() => `ssh command finished: ${resultInfo()}`)
                  if (throwOnNonZero && code) {
                    reject(
                      new Error(`command exited with non-zero ${resultInfo()}`)
                    )
                  } else {
                    resolve({
                      code: code || 0,
                      stdout,
                      stderr,
                    })
                  }
                }
              }
            })
            if (stdin) {
              channel.stdin.end(stdin, () => {
                stdinDone = true
              })
            }
          }
        )
      }
    )
  }

  async execScript(
    script: string,
    options: {
      sudo?: boolean | undefined
      timeout?: number | undefined
      throwOnNonZero?: boolean | undefined
    } = {}
  ): Promise<ExecResult> {
    const { sudo, ...otherOptions } = options
    return await this.exec(`${sudo ? 'sudo ' : ''}bash -s`, {
      ...otherOptions,
      stdin: script,
    })
  }

  async putFile(localPath: string, remotePath: string): Promise<void> {
    await this.connectIfNeeded()
    const { client } = this
    const sftp: SFTPWrapper = await promisify(client.sftp.bind(client))()
    await promisify(sftp.fastPut.bind(sftp))(localPath, remotePath)
  }
}
