module.exports = {
  apps: [
    {
      name: 'abhicabs-web',
      script: 'src/server.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '400M',
    },
    {
      name: 'abhicabs-worker',
      script: 'src/workers/index.js',
      instances: 1,
      env: { NODE_ENV: 'production' },
      max_memory_restart: '400M',
    },
  ],
};