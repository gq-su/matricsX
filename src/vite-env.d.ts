/// <reference types="vite/client" />

interface Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: Array<{
      description?: string
      accept: Record<string, string[]>
    }>
  }) => Promise<FileSystemFileHandle>
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: FileSystemHandle | WellKnownDirectory
  }) => Promise<FileSystemDirectoryHandle>
}

type WellKnownDirectory =
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'

interface FileSystemHandle {
  readonly kind: 'file' | 'directory'
  readonly name: string
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: 'file'
  createWritable: () => Promise<FileSystemWritableFileStream>
  getFile: () => Promise<File>
  requestPermission: (descriptor: {
    mode?: 'read' | 'readwrite'
  }) => Promise<PermissionState>
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: 'directory'
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileSystemFileHandle>
  removeEntry: (
    name: string,
    options?: { recursive?: boolean },
  ) => Promise<void>
  requestPermission: (descriptor: {
    mode?: 'read' | 'readwrite'
  }) => Promise<PermissionState>
  values: () => AsyncIterableIterator<FileSystemHandle>
}

interface FileSystemWritableFileStream extends WritableStream {
  write: (data: string | BufferSource | Blob) => Promise<void>
  close: () => Promise<void>
}
