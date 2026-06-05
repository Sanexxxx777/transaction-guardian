module.exports = {
  apps: [{
    name: 'tx-guardian',
    script: 'dist/index.js',
    node_args: '--enable-source-maps',
    env: {
      NODE_ENV: 'production',
    },
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    max_memory_restart: '300M',
  }],
};
