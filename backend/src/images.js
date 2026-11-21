// Server-side image work. Blurring happens here, not in the browser, so a finder never
// receives a URL to the sharp original (a CSS blur could just be switched off).
import sharp from 'sharp';

export const DISPLAY_MAX = 1024;

// A blurred JPEG copy of `buffer` for the finder to look at. sigma: Gaussian blur radius in px.
export async function blurredCopy(buffer, sigma) {
  return sharp(buffer, { failOn: 'error' })
    .rotate() // respect phone EXIF orientation before the EXIF data is dropped
    .resize({ width: DISPLAY_MAX, height: DISPLAY_MAX, fit: 'inside', withoutEnlargement: true })
    .blur(sigma)
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
}
