import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
  preview: { host: true, allowedHosts: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('maplibre-gl')) return 'vendor-map'
          if (id.includes('@supabase')) return 'vendor-supabase'
          // Paquets React exacts : « includes('react') » attrapait aussi @react-three/*,
          // ce qui créait un cycle entre chunks et cassait le chargement en prod.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (id.includes('d3') || id.includes('topojson-client')) return 'vendor-geo'
          return 'vendor'
        },
      },
    },
  },
})
