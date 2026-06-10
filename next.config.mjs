/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // Load .sql files as raw strings (handles BigQuery backticks safely).
    config.module.rules.push({ test: /\.sql$/, type: 'asset/source' });
    return config;
  },
};

export default nextConfig;
