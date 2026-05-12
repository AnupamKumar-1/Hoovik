
const base = {
    script: "./src/app.js",
    interpreter: "node",
    env_file: ".env",
    watch: false,
    max_memory_restart: "512M",
    exp_backoff_restart_delay: 100,
    merge_logs: true,
    time: true,
    log_date_format: "YYYY-MM-DD HH:mm:ss",

    env: {
        NODE_ENV: "production",
    },
};

module.exports = {
    apps: [
        { ...base, name: "skymeetai-8000", env: { ...base.env, PORT: 8000 } },
        { ...base, name: "skymeetai-8001", env: { ...base.env, PORT: 8001 } },
        { ...base, name: "skymeetai-8002", env: { ...base.env, PORT: 8002 } },
    ],
};