/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--trusted-host`) and its `--help`
 * text, then provides the immutable values as {@link WEB_STARTUP_SERVICE}.
 * Ordinary rows inject that service before reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Environment variable naming the default listen port when `--port` is absent. */
const PORT_ENV = 'PORT'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /** Explicit `--trusted-origin` origins, in argument order. */
  trustedOrigins: string[]
  /** `--dev`: disable every /api browser-trust fence for this process. */
  dev: boolean
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  port?: string
  trustedHost?: string[]
  trustedOrigin?: string[]
  dev?: boolean
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host (127.0.0.1 or 0.0.0.0)')
    .option('--port <port>', 'listen port; falls back to $PORT, then 3080; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--trusted-origin <origin...>', 'extra absolute origin the /api Origin fence accepts (scheme://host[:port]; repeatable)')
    .option('--dev', 'disable every /api browser-trust fence (Host, Origin, privileged loopback pin); development only, never expose it')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on $PORT or 3080
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --trusted-origin https://app.example --trusted-host app.example
                                             serve behind a reverse tunnel fronting app.example
  dsh --profile web --host 0.0.0.0 --dev     serve on every interface for a proxy-fronted deployment
  dsh --profile web --dev                    serve with all /api browser-trust fences off (local development)
`)
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; a non-numeric
 * `--port` (or `$PORT`, which supplies the default when the flag is absent)
 * is a usage error, so on rejection (and on `--help`) nothing is provided.
 * `--host 0.0.0.0` binds every interface, for proxy-fronted deployments; the
 * /api browser-trust fences still gate access unless `--dev` disables them.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    // The platform convention: a containerized deployment supplies $PORT and
    // never a flag, so an absent --port falls back to it; the webserver row's
    // 3080 remains the final default when neither names a port. Validated with
    // the same digits-only rule as the flag, so a malformed $PORT fails loud
    // instead of silently serving on an unreadable default.
    const port = options.port ?? process.env[PORT_ENV]
    if (port !== undefined && !/^\d+$/.test(port)) {
      program.error(`error: $${PORT_ENV} must be a number, got ${JSON.stringify(port)}`)
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      ...options.host !== undefined && { host: options.host },
      ...port !== undefined && { port: Number(port) },
      trustedHosts: options.trustedHost ?? [],
      trustedOrigins: options.trustedOrigin ?? [],
      dev: options.dev ?? false,
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
