// Loaded before test imports. No inference or attestation service can be contacted.
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('TEST_NETWORK_FORBIDDEN'); };
globalThis.fetch = denied;
http.request = http.get = https.request = https.get = denied;
http2.connect = net.connect = net.createConnection = tls.connect = denied;
net.Socket.prototype.connect = denied;
syncBuiltinESMExports();
