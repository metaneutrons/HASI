import { z } from 'zod';

export interface PluginPresentationCsp {
  connectDomains: string[];
  resourceDomains: string[];
}

export interface PluginPresentation {
  id: string;
  resourceUri: string;
  mimeType: 'text/html;profile=mcp-app';
  sha256: string;
  csp: PluginPresentationCsp;
}

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/);
const domainList = z.array(hostname).max(16).superRefine((domains, context) => {
  if (new Set(domains).size !== domains.length) {
    context.addIssue({ code: 'custom', message: 'CSP domains must not contain duplicates' });
  }
});

const resourceUri = z
  .string()
  .min(6)
  .max(256)
  .regex(/^ui:\/\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*)*$/)
  .superRefine((uri, context) => {
    const path = uri.slice('ui://'.length).split('/').slice(1);
    if (path.some((segment) => segment === '.' || segment === '..')) {
      context.addIssue({ code: 'custom', message: 'presentation resource URI must not contain dot path segments' });
    }
  });

export const presentationSchema = z
  .object({
    id: identifier,
    resourceUri,
    mimeType: z.literal('text/html;profile=mcp-app'),
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    csp: z
      .object({
        connectDomains: domainList,
        resourceDomains: domainList,
      })
      .strict(),
  })
  .strict();

export type PluginPresentationInput = z.input<typeof presentationSchema>;
