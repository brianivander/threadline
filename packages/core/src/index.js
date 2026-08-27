// Threadline core — public API.
// Filesystem-backed: a workspace is a plain directory tree of arbitrary
// depth — folders (directories) and files (markdown, see story-file.js).
// No database, no build step — every id is a path.

export { parseStoryFile, serializeStoryFile, THREAD_STATUSES } from './story-file.js'

export {
  IMAGE_DIR,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  assetFileName,
  deleteImage,
  imageDirFor,
  isManagedImagePath,
  isReferencedElsewhere,
  repoRootFor,
  saveImage,
} from './assets.js'

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
  listTabs,
  getTab,
  createTab,
  updateTab,
  deleteTab,
  reorderTabs,
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
