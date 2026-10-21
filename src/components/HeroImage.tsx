import { useState } from 'react'
import { optimizedImageUrl } from '../utils/imageUrl'

// Wikivoyage banners are ~7:1: past this ratio the hero pans across the whole
// panorama instead of slowly zooming on its centre.
const PANORAMA_RATIO = 2.5

export function HeroImage({ src }: { src: string }) {
  const [panorama, setPanorama] = useState(false)
  return (
    <img
      className="destination-hero-img"
      src={optimizedImageUrl(src)}
      alt=""
      loading="lazy"
      decoding="async"
      data-panorama={panorama || undefined}
      onLoad={event => {
        const img = event.currentTarget
        setPanorama(img.naturalWidth / Math.max(img.naturalHeight, 1) >= PANORAMA_RATIO)
      }}
    />
  )
}
