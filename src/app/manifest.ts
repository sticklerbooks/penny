import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Penny',
    short_name: 'Penny',
    description: 'Your personal assistant',
    start_url: '/',
    display: 'standalone',
    background_color: '#FAF8F5',
    theme_color: '#F59E0B',
    icons: [
      {
        src: '/icon',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icon',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
