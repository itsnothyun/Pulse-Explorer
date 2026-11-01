import type { FastifyInstance } from 'fastify';
import type { OmniViewMemoryStore, UserPreferences } from '../store.js';

export async function registerUserRoutes(
  app: FastifyInstance,
  store: OmniViewMemoryStore
): Promise<void> {
  // GET /api/v1/users/me
  app.get('/api/v1/users/me', async () => {
    return {
      user: store.currentUser,
    };
  });

  // PATCH /api/v1/users/me/preferences
  app.patch<{ Body: Partial<UserPreferences> }>(
    '/api/v1/users/me/preferences',
    async (request) => {
      const updates = request.body ?? {};
      store.currentUser.preferences = {
        ...store.currentUser.preferences,
        ...updates,
      };
      store.currentUser.updatedAt = new Date().toISOString();

      store.recordAudit('user.preferences_updated', 'user', store.currentUser.id, {
        updatedKeys: Object.keys(updates),
      });

      return {
        user: store.currentUser,
        preferences: store.currentUser.preferences,
      };
    }
  );
}
