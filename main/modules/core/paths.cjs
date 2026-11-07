// 唯一路径契约（0.6.0）。
//
// 这是 CommonJS 文件：Electron 主进程直接 require，ESM 模块用
// `import paths from '../core/paths.cjs'` 读同一个对象 —— 只维护一份常量，
// 不再靠 `../..` 猜层级。
//
// 目录口径：
//   main/          运行所需的一切
//   main/deps/     真实依赖实体（node_modules + vendor）
//   main/config/   人手维护的配置
//   main/runtime/  运行时写盘（gitignore）
//   main/docs/     文档
//   plugins/       插件侧文件（运行数据跟随插件安装位置）

'use strict'

const { join, resolve } = require('node:path')
const { homedir } = require('node:os')

const MAIN_ROOT = resolve(__dirname, '..', '..')

// ---------- 依赖 ----------
const DEPS_DIR = join(MAIN_ROOT, 'deps')
const NODE_MODULES = join(DEPS_DIR, 'node_modules')
const VENDOR_DIR = join(DEPS_DIR, 'vendor')

// ---------- 配置 ----------
const CONFIG_DIR = join(MAIN_ROOT, 'config')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const COMMANDS_FILE = join(CONFIG_DIR, 'commands.json')

// ---------- 运行时 ----------
const RUNTIME_DIR = join(MAIN_ROOT, 'runtime')
const RUNTIME_APP = join(RUNTIME_DIR, 'app')
const RUNTIME_AUDIT = join(RUNTIME_DIR, 'audit')
const RUNTIME_LOGS = join(RUNTIME_DIR, 'logs')
const CHROMIUM_DIR = join(RUNTIME_DIR, 'chromium')

const WINDOW_FILE = join(RUNTIME_APP, 'window.json')
const SETTINGS_FILE = join(RUNTIME_APP, 'settings.json')
const EVENTS_FILE = join(RUNTIME_APP, 'pet-events.json')
const TUTORIAL_STATE_FILE = join(RUNTIME_APP, 'tutorial-state.json')
const PRESETS_USER_FILE = join(RUNTIME_APP, 'presets-user.json')
const ENDPOINT_MIRROR = join(RUNTIME_APP, 'endpoint.json')
const SHORTCUTS_MIRROR = join(RUNTIME_APP, 'shortcuts.json')
const INSTALL_STATE_FILE = join(RUNTIME_APP, 'install-state.json')
const AUDIT_FILE = join(RUNTIME_AUDIT, 'commands-audit.jsonl')
const RUN_LOG = join(RUNTIME_LOGS, 'run.log')
const LAUNCH_LOG = join(RUNTIME_LOGS, 'launch.log')
const CRASH_LOG = join(RUNTIME_LOGS, 'crash.log')
const SHORTCUT_HELPER_LOG = join(RUNTIME_LOGS, 'shortcut-helper.log')
const INSTALL_AGENT_LOG = join(RUNTIME_LOGS, 'install-agent.log')

// ---------- 内容 ----------
const DOCS_DIR = join(MAIN_ROOT, 'docs')
const TUTORIAL_FILE = join(DOCS_DIR, 'tutorial.md')
const MODEL_DIR = join(MAIN_ROOT, 'model', 'runtime')
const MODEL_SOURCE_DIR = join(MAIN_ROOT, 'model', 'source')
const PERSONA_DIR = join(MAIN_ROOT, 'persona')

// ---------- 模块 ----------
const MODULES_DIR = join(MAIN_ROOT, 'modules')
const CORE_DIR = join(MODULES_DIR, 'core')
const UI_DIR = join(MODULES_DIR, 'ui')
const MENU_DIR = join(MODULES_DIR, 'menu')
const SETTINGS_DIR = join(MODULES_DIR, 'settings')
const BEHAVIOR_DIR = join(MODULES_DIR, 'behavior')
const COMMANDS_DIR = join(MODULES_DIR, 'commands')
const LOW_POWER_DIR = join(MODULES_DIR, 'low-power')
const TUTORIAL_DIR = join(MODULES_DIR, 'tutorial')
const SCRIPTS_DIR = join(MAIN_ROOT, 'scripts')

// ---------- 与插件共享的握手目录（协议契约，插件侧有等价常量） ----------
const DIR = join(homedir(), '.dsh', 'live2d')
const STATUS = join(DIR, 'status.json')
const STATUS_TMP = join(DIR, 'status.json.tmp')
const ENDPOINT = join(DIR, 'endpoint.json')
const SHORTCUTS = join(DIR, 'shortcuts.json')
const EXPRESSION_MAP = join(DIR, 'expression-map.json')

module.exports = {
  MAIN_ROOT,
  DEPS_DIR,
  NODE_MODULES,
  VENDOR_DIR,
  CONFIG_DIR,
  CONFIG_FILE,
  COMMANDS_FILE,
  RUNTIME_DIR,
  RUNTIME_APP,
  RUNTIME_AUDIT,
  RUNTIME_LOGS,
  CHROMIUM_DIR,
  WINDOW_FILE,
  SETTINGS_FILE,
  EVENTS_FILE,
  TUTORIAL_STATE_FILE,
  PRESETS_USER_FILE,
  ENDPOINT_MIRROR,
  SHORTCUTS_MIRROR,
  INSTALL_STATE_FILE,
  AUDIT_FILE,
  RUN_LOG,
  LAUNCH_LOG,
  CRASH_LOG,
  SHORTCUT_HELPER_LOG,
  INSTALL_AGENT_LOG,
  DOCS_DIR,
  TUTORIAL_FILE,
  MODEL_DIR,
  MODEL_SOURCE_DIR,
  PERSONA_DIR,
  MODULES_DIR,
  CORE_DIR,
  UI_DIR,
  MENU_DIR,
  SETTINGS_DIR,
  BEHAVIOR_DIR,
  COMMANDS_DIR,
  LOW_POWER_DIR,
  TUTORIAL_DIR,
  SCRIPTS_DIR,
  DIR,
  STATUS,
  STATUS_TMP,
  ENDPOINT,
  SHORTCUTS,
  EXPRESSION_MAP,
}
