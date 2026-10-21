import { connection } from './src/state.js';

const c = await connection();
document.querySelector('#o-server').textContent = c.server;
document.querySelector('#o-vault').textContent = c.token ? (c.vault || 'Connected') : 'Not connected: use the popup to connect.';
