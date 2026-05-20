/** @type {import('next').NextConfig} */
const nextConfig = {
  // Prevent bundling of native modules (sharp, fluent-ffmpeg)
  experimental: {
    serverComponentsExternalPackages: ["sharp", "fluent-ffmpeg"],
  },

  // Security headers
  async headers() {
    const immichOrigin = process.env.IMMICH_API_URL || "http://localhost:2283";

    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "X-DNS-Prefetch-Control",
            value: "off",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' blob: data:",
              "media-src 'self' blob:",
              "connect-src 'self'",
              "font-src 'self'",
              `connect-src 'self' ${immichOrigin}`,
              `img-src 'self' blob: data: ${immichOrigin}`,
              "frame-ancestors 'none'",
              "base-uri 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },

  // Build output standalone for production
  output: "standalone",
};

export default nextConfig;
