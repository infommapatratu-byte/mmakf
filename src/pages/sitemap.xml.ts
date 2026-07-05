// Hand-rolled sitemap (FUT-16 / MASTER-SPEC F23): SSR output prevents
// @astrojs/sitemap, so the 12 public routes are listed explicitly.

import type { APIRoute } from 'astro';

export const prerender = false;

const ROUTES = [
  '/', '/about', '/programs', '/facilities', '/schedule', '/belt-system',
  '/events', '/gallery', '/shop', '/faq', '/contact', '/affiliation',
];

export const GET: APIRoute = ({ site }) => {
  const origin = (site?.href || 'https://www.mmakf.in/').replace(/\/$/, '');
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    ROUTES.map((r) => `  <url><loc>${origin}${r}</loc></url>`).join('\n') +
    `\n</urlset>\n`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
};
