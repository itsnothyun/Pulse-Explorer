import type { FastifyInstance } from 'fastify';
import type { WorkspaceFolder } from '@omniview/shared-types';
import type { OmniViewMemoryStore } from '../store.js';

interface CreateFolderBody {
  name?: string;
  parentId?: string | null;
  color?: string;
}

interface UpdateFolderBody {
  name?: string;
  parentId?: string | null;
  color?: string;
}

export async function registerFolderRoutes(
  app: FastifyInstance,
  store: OmniViewMemoryStore
): Promise<void> {
  // GET /api/v1/folders
  app.get('/api/v1/folders', async () => {
    const folders = Array.from(store.folders.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    return {
      folders,
      total: folders.length,
    };
  });

  // POST /api/v1/folders
  app.post<{ Body: CreateFolderBody }>('/api/v1/folders', async (request, reply) => {
    const body = request.body ?? {};
    const name = body.name?.trim();
    if (!name) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_FOLDER_NAME',
          message: 'A non-empty folder name is required.',
        },
      });
    }

    const folder: WorkspaceFolder = {
      id: store.nextId('fld'),
      name,
      parentId: body.parentId ?? null,
      color: body.color ?? '#6366f1',
      createdAt: new Date().toISOString(),
    };

    store.folders.set(folder.id, folder);
    store.recordAudit('folder.created', 'folder', folder.id, { name });

    return reply.status(201).send({ folder });
  });

  // PATCH /api/v1/folders/:id
  app.patch<{
    Params: { id: string };
    Body: UpdateFolderBody;
  }>('/api/v1/folders/:id', async (request, reply) => {
    const { id } = request.params;
    const folder = store.folders.get(id);
    if (!folder) {
      return reply.status(404).send({
        error: {
          code: 'FOLDER_NOT_FOUND',
          message: `Folder "${id}" does not exist.`,
        },
      });
    }

    const body = request.body ?? {};
    if (typeof body.name === 'string' && body.name.trim()) {
      folder.name = body.name.trim();
    }
    if (body.parentId !== undefined) {
      folder.parentId = body.parentId;
    }
    if (typeof body.color === 'string') {
      folder.color = body.color;
    }

    store.folders.set(id, folder);
    store.recordAudit('folder.updated', 'folder', id, { name: folder.name });

    return { folder };
  });

  // DELETE /api/v1/folders/:id
  app.delete<{ Params: { id: string } }>('/api/v1/folders/:id', async (request, reply) => {
    const { id } = request.params;
    const folder = store.folders.get(id);
    if (!folder) {
      return reply.status(404).send({
        error: {
          code: 'FOLDER_NOT_FOUND',
          message: `Folder "${id}" does not exist.`,
        },
      });
    }

    store.folders.delete(id);
    for (const file of store.files.values()) {
      if (file.folderId === id) {
        file.folderId = null;
      }
    }

    store.recordAudit('folder.deleted', 'folder', id);
    return {
      deleted: true,
      id,
    };
  });
}
