import Fastify, { type FastifyInstance } from 'fastify';
import { OMNIVIEW_CONFIG } from '@omniview/config';
import { OmniViewMemoryStore } from './store.js';
import { validateSafeRemoteUrl, type UrlValidationResult } from './ssrf.js';
import { registerFileRoutes } from './routes/files.js';
import { registerPreviewRoutes } from './routes/previews.js';
import { registerAnnotationRoutes } from './routes/annotations.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerUserRoutes } from './routes/users.js';

export { OmniViewMemoryStore, validateSafeRemoteUrl, type UrlValidationResult };

export interface BuildApiServerOptions {
  logger?: boolean;
  store?: OmniViewMemoryStore;
}

export type OmniViewApiServer = FastifyInstance & {
  omniviewStore: OmniViewMemoryStore;
};

export function buildApiServer(options: BuildApiServerOptions = {}): OmniViewApiServer {
  const store = options.store ?? new OmniViewMemoryStore();
  const baseApp = Fastify({
    logger: options.logger ?? false,
    bodyLimit: OMNIVIEW_CONFIG.limits.maxFileSizeBytes,
  });
  const app: OmniViewApiServer = Object.assign(baseApp, { omniviewStore: store });

  // Add standard security headers and CORS support on all responses
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Range, Authorization');
    reply.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, ETag');
    return payload;
  });

  app.options('*', async (_request, reply) => {
    return reply.status(204).send();
  });

  // Healthcheck endpoint
  app.get('/api/v1/health', async () => ({
    status: 'ok',
    service: '@omniview/api',
    version: OMNIVIEW_CONFIG.appVersion,
    apiVersion: OMNIVIEW_CONFIG.apiVersion,
    timestamp: new Date().toISOString(),
  }));

  void registerFileRoutes(app, store);
  void registerPreviewRoutes(app, store);
  void registerAnnotationRoutes(app, store);
  void registerFolderRoutes(app, store);
  void registerUserRoutes(app, store);

  return app;
}

const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('apps/api/src/index.ts') ||
    process.argv[1].endsWith('apps\\api\\src\\index.ts'));

if (isMainModule) {
  const port = Number.parseInt(process.env.PORT ?? '4000', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  const server = buildApiServer({ logger: true });
  server.listen({ port, host }).catch((err) => {
    server.log.error(err);
    process.exit(1);
  });
}
