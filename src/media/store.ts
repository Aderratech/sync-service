import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DataLakeServiceClient } from '@azure/storage-file-datalake';
import { DefaultAzureCredential } from '@azure/identity';

/**
 * Where photos and audio are kept (docs/sync-service.md). In Azure: the lakehouse Files area in OneLake,
 * written with the Function App's managed identity. Locally and in tests: a folder on disk.
 * Paths are the `media.onelake_path` value, e.g. `Files/interim/uploads/{report_id}/{media_id}`.
 */
export interface MediaStore {
  put(path: string, data: Buffer, contentType: string): Promise<void>;
  /** The file, or null when there is none. */
  get(path: string): Promise<Buffer | null>;
}

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** `MEDIA_STORE=local` (the default): files under MEDIA_LOCAL_DIR, else `.media/` in the working folder. */
class LocalStore implements MediaStore {
  private readonly root = resolve(process.env.MEDIA_LOCAL_DIR ?? '.media');

  private file(path: string): string {
    const full = resolve(join(this.root, path));
    if (!full.startsWith(this.root)) throw new Error('Media path outside the store');
    return full;
  }

  async put(path: string, data: Buffer): Promise<void> {
    const file = this.file(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(path: string): Promise<Buffer | null> {
    try {
      return await readFile(this.file(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

/**
 * `MEDIA_STORE=onelake`: the lakehouse `ONELAKE_LAKEHOUSE` in the workspace `ONELAKE_WORKSPACE`, through
 * OneLake's ADLS Gen2 endpoint. The identity needs Contributor on the workspace.
 */
class OneLakeStore implements MediaStore {
  private readonly fileSystem;
  private readonly lakehouse: string;

  constructor(workspace: string, lakehouse: string) {
    const service = new DataLakeServiceClient('https://onelake.dfs.fabric.microsoft.com', new DefaultAzureCredential());
    this.fileSystem = service.getFileSystemClient(workspace);
    this.lakehouse = lakehouse;
  }

  private client(path: string) {
    return this.fileSystem.getFileClient(`${this.lakehouse}.Lakehouse/${path}`);
  }

  async put(path: string, data: Buffer, contentType: string): Promise<void> {
    await this.client(path).upload(data, { pathHttpHeaders: { contentType } });
  }

  async get(path: string): Promise<Buffer | null> {
    try {
      return await this.client(path).readToBuffer();
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }
}

let store: MediaStore | null = null;

export function mediaStore(): MediaStore {
  if (!store) {
    if (process.env.MEDIA_STORE === 'onelake') {
      const workspace = process.env.ONELAKE_WORKSPACE;
      const lakehouse = process.env.ONELAKE_LAKEHOUSE;
      if (!workspace || !lakehouse) throw new Error('ONELAKE_WORKSPACE and ONELAKE_LAKEHOUSE must be set');
      store = new OneLakeStore(workspace, lakehouse);
    } else {
      store = new LocalStore();
    }
  }
  return store;
}

/** Tests swap in their own store. */
export function setMediaStore(next: MediaStore | null): void {
  store = next;
}
