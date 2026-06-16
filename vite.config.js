import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import fs from 'node:fs';
import path from 'node:path';

// ----------------------------------------------------------------------------
// Dev-server scenario file persistence.
//
// User-authored scenarios live in localStorage (instant, offline), but that
// traps them in one browser profile — they can't be shared, version-
// controlled, or inspected outside the app. This plugin mirrors every save to
// a real JSON file under `<project>/scenarios/` so they're durable, diff-able
// and committable. The editor POSTs here on save/delete; the registry reads
// the same folder back at boot (see src/systems/scenarios/index.js). Dev-only.
// ----------------------------------------------------------------------------
function userScenarioFilesPlugin() {
	const dir = path.resolve(process.cwd(), 'scenarios');
	const safeId = (id) => String(id || '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80) || 'untitled';
	const readJson = (req) => new Promise((resolve) => {
		let data = '';
		req.on('data', (c) => { data += c; });
		req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
		req.on('error', () => resolve({}));
	});
	const sendJson = (res, code, obj) => {
		res.statusCode = code;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify(obj));
	};
	return {
		name: 'user-scenario-files',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use('/__scenarios/save', async (req, res) => {
				if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
				const { id, json } = await readJson(req);
				if (!id || !json || typeof json !== 'object') return sendJson(res, 400, { error: 'need {id, json}' });
				try {
					fs.mkdirSync(dir, { recursive: true });
					fs.writeFileSync(path.join(dir, safeId(id) + '.json'), JSON.stringify(json, null, '\t') + '\n');
					sendJson(res, 200, { ok: true, file: `scenarios/${safeId(id)}.json` });
				} catch (e) { sendJson(res, 500, { error: String(e) }); }
			});
			server.middlewares.use('/__scenarios/delete', async (req, res) => {
				if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
				const { id } = await readJson(req);
				try {
					fs.rmSync(path.join(dir, safeId(id) + '.json'), { force: true });
					sendJson(res, 200, { ok: true });
				} catch (e) { sendJson(res, 500, { error: String(e) }); }
			});
		},
	};
}

export default defineConfig({
	plugins: [cesium(), userScenarioFilesPlugin()],
});
