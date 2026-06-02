import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Penny',
    short_name: 'Penny',
    description: 'Your personal assistant',
    start_url: '/',
    display: 'standalone',
    background_color: '#0B0C10',
    theme_color: '#FF69B4',
    icons: [
      {
        src: '/icon.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
