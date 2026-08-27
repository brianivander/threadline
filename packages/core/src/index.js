// Threadline core — public API.
// Filesystem-backed: a workspace is a plain directory tree of arbitrary
// depth — folders (directories) and files (markdown, see story-file.js).
// No database, no build step — every id is a path.

export { parseStoryFile, serializeStoryFile, THREAD_STATUSES } from './story-file.js'

export {
  CRITICALITIES,
  FILE_EXTS,
  TEXT_OPEN_EXTS,
  listFolders,
  getFolder,
  createFolder,
  updateFolder,
  deleteFolder,
  listFiles,
  getFile,
  createFile,
  updateFile,
  deleteFile,
  listCases,
  getCase,
  createCase,
  updateCase,
  deleteCase,
  reorderCases,
  moveNode,
  duplicateNode,
  buildTree,
  listChildren,
  searchFiles,
  listThreads,
  createThread,
  addReply,
  setThreadStatus,
  deleteThread,
  scanThreads,
  extractMentions,
} from './repo.js'
