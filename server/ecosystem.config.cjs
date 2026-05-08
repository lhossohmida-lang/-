module.exports = {
  apps: [{
    name: 'deku-ai-backend',
    script: 'server.js',
    cwd: __dirname,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    time: true
  }]
};
