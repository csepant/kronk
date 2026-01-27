/**
 * Tool Handlers Index
 *
 * Exports all built-in tool handlers and their schemas.
 */

export {
  shellToolSchema,
  createShellHandler,
  type ShellResult,
  type ShellConfirmEvent,
} from './shell.js';

export {
  createTaskToolSchema,
  createTaskHandler,
  type CreateTaskResult,
} from './task.js';

export {
  createToolToolSchema,
  createCreateToolHandler,
  createDynamicHandler,
  loadDynamicTools,
  type HandlerType,
  type CreateToolResult,
} from './create-tool.js';

export {
  discoverToolsSchema,
  createDiscoverToolsHandler,
  type DiscoverToolsResult,
} from './discover-tools.js';

export {
  discoverSkillsSchema,
  createDiscoverSkillsHandler,
  readSkillSchema,
  createReadSkillHandler,
  type DiscoverSkillsResult,
  type ReadSkillResult,
} from './skills.js';
