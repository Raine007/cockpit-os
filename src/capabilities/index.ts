/**
 * Importing this barrel triggers registration of every capability.
 * The MCP server and the SKILL compiler both import from here so they always
 * see the same set of capabilities.
 *
 * Add new capabilities by importing them here. The registry will reject
 * duplicates at startup.
 */

export { taskCreate } from './task-create.js';
export { taskList } from './task-list.js';
export { flightLog } from './flight-log.js';
export { noteAppend } from './note-append.js';
