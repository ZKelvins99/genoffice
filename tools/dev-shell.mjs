/**
 * Start the shell Electron app with per-app Vite renderer URLs.
 *
 * Root `npm run dev` cannot use `VAR=value cmd` — that is a Unix shell idiom and
 * fails under Windows cmd.exe. This helper sets the env in-process and spawns
 * the shell workspace the same way on every platform.
 */
import { spawn } from 'node:child_process'

const child = spawn('npm', ['run', 'dev', '-w', '@genoffice/shell'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    DOCS_RENDERER_URL: 'http://localhost:5173',
    SHEETS_RENDERER_URL: 'http://localhost:5174',
    SLIDES_RENDERER_URL: 'http://localhost:5175',
    PDF_RENDERER_URL: 'http://localhost:5176',
    MARKDOWN_RENDERER_URL: 'http://localhost:5177',
    HTML_RENDERER_URL: 'http://localhost:5178',
  },
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
