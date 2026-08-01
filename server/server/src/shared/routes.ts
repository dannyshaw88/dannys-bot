import { z } from 'zod/v4';
import { insertProxySchema, insertProfileSchema, insertToolSchema, insertSourceSchema } from './schema';
import type { Proxy, Profile, Tool, Source } from './schema';

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

export const api = {
  proxies: {
    list: {
      method: 'GET' as const,
      path: '/api/proxies' as const,
      responses: {
        200: z.array(z.custom<Proxy>()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/proxies' as const,
      input: insertProxySchema,
      responses: {
        201: z.custom<Proxy>(),
        400: errorSchemas.validation,
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/proxies/:id' as const,
      responses: {
        204: z.void(),
        404: errorSchemas.notFound,
      },
    },
  },
  profiles: {
    list: {
      method: 'GET' as const,
      path: '/api/profiles' as const,
      responses: {
        200: z.array(z.custom<Profile>()),
      },
    },
    get: {
      method: 'GET' as const,
      path: '/api/profiles/:id' as const,
      responses: {
        200: z.custom<Profile>(),
        404: errorSchemas.notFound,
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/profiles' as const,
      input: insertProfileSchema,
      responses: {
        201: z.custom<Profile>(),
        400: errorSchemas.validation,
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/profiles/:id' as const,
      input: insertProfileSchema.partial(),
      responses: {
        200: z.custom<Profile>(),
        404: errorSchemas.notFound,
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/profiles/:id' as const,
      responses: {
        204: z.void(),
        404: errorSchemas.notFound,
      },
    },
    start: {
      method: 'POST' as const,
      path: '/api/profiles/:id/start' as const,
      responses: {
        200: z.object({ status: z.string() }),
        404: errorSchemas.notFound,
      },
    },
    stop: {
      method: 'POST' as const,
      path: '/api/profiles/:id/stop' as const,
      responses: {
        200: z.object({ status: z.string() }),
        404: errorSchemas.notFound,
      },
    },
  },
  tools: {
    listByProfile: {
      method: 'GET' as const,
      path: '/api/profiles/:profileId/tools' as const,
      responses: {
        200: z.array(z.custom<Tool>()),
      },
    },
    update: {
      method: 'PUT' as const,
      path: '/api/tools/:id' as const,
      input: insertToolSchema.partial(),
      responses: {
        200: z.custom<Tool>(),
        404: errorSchemas.notFound,
      },
    },
  },
  sources: {
    listByTool: {
      method: 'GET' as const,
      path: '/api/tools/:toolId/sources' as const,
      responses: {
        200: z.array(z.custom<Source>()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/tools/:toolId/sources' as const,
      input: insertSourceSchema.omit({ toolId: true }),
      responses: {
        201: z.custom<Source>(),
        400: errorSchemas.validation,
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/sources/:id' as const,
      responses: {
        204: z.void(),
        404: errorSchemas.notFound,
      },
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
