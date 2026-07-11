import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / 'apply_customizations.py'
SPEC = importlib.util.spec_from_file_location('apply_customizations', SCRIPT_PATH)
assert SPEC and SPEC.loader
CUSTOMIZATIONS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CUSTOMIZATIONS)


CLIENT_SOURCE = """import type { ServerRuntimeKind } from '@/types';

class ApiClient {
  private apiBase: string = '';
  private managementKey: string = '';

  setConfig(config: ApiClientConfig): void {
    this.apiBase = computeApiUrl(config.apiBase);
    this.managementKey = config.managementKey;

    if (config.timeout) {
      this.instance.defaults.timeout = config.timeout;
    }
  }

  private readHeader(headers: Record<string, unknown> | undefined, keys: string[]): string | null {
    return null;
  }

  private setupInterceptors(): void {
    this.instance.interceptors.response.use(
      (response) => {
        const homeVersion = this.readHeader(response.headers, HOME_VERSION_HEADER_KEYS);
        const homeBuildDate = this.readHeader(response.headers, HOME_BUILD_DATE_HEADER_KEYS);
        const cpaVersion = this.readHeader(response.headers, CPA_VERSION_HEADER_KEYS);
        const cpaBuildDate = this.readHeader(response.headers, CPA_BUILD_DATE_HEADER_KEYS);
        const runtimeKind: ServerRuntimeKind | null =
          homeVersion || homeBuildDate ? 'home' : cpaVersion || cpaBuildDate ? 'cpa' : null;

        // 触发版本更新事件（后续通过 store 处理）
        return response;
      }
    );
  }
}
"""


VERSION_SOURCE = """import { apiClient } from './client';
import type { ServerRuntimeKind } from '@/types';
import { isRecord } from '@/utils/helpers';

export const versionApi = {
  checkLatest: () => apiClient.get<Record<string, unknown>>('/latest-version'),

  async detectRuntimeKind(): Promise<ServerRuntimeKind> {
    try {
      const data = await apiClient.get('/nodes');
      return isRecord(data) && Array.isArray(data.nodes) ? 'home' : 'unknown';
    } catch (error: unknown) {
      const status = isRecord(error) ? error.status : undefined;
      if (status === 404 || status === 405) {
        return 'cpa';
      }
      return 'unknown';
    }
  },
};
"""


class RuntimeDetectionCustomizationTest(unittest.TestCase):
    def setUp(self):
        CUSTOMIZATIONS._writes.clear()

    def tearDown(self):
        CUSTOMIZATIONS._writes.clear()

    def test_uses_response_headers_without_nodes_probe(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            api_dir = target / 'src/services/api'
            api_dir.mkdir(parents=True)
            client_path = api_dir / 'client.ts'
            version_path = api_dir / 'version.ts'
            client_path.write_text(CLIENT_SOURCE)
            version_path.write_text(VERSION_SOURCE)

            CUSTOMIZATIONS.patch_runtime_detection(target)
            CUSTOMIZATIONS.flush_writes()
            CUSTOMIZATIONS._writes.clear()
            CUSTOMIZATIONS.patch_runtime_detection(target)
            CUSTOMIZATIONS.flush_writes()

            client = client_path.read_text()
            version = version_path.read_text()

            self.assertEqual(client.count("private runtimeKind: ServerRuntimeKind = 'unknown';"), 1)
            self.assertEqual(client.count('getRuntimeKind(): ServerRuntimeKind'), 1)
            self.assertIn('const connectionChanged =', client)
            self.assertIn('if (connectionChanged) {', client)
            self.assertIn("this.runtimeKind = 'unknown';", client)
            self.assertIn('this.runtimeKind = runtimeKind;', client)
            self.assertIn('const runtimeKind = apiClient.getRuntimeKind();', version)
            self.assertIn("return runtimeKind === 'unknown' ? 'cpa' : runtimeKind;", version)
            self.assertNotIn("apiClient.get('/nodes')", version)
            self.assertNotIn("from '@/utils/helpers'", version)

    def test_leaves_newer_upstream_detection_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            api_dir = target / 'src/services/api'
            api_dir.mkdir(parents=True)
            version_path = api_dir / 'version.ts'
            source = "export const versionApi = { detectRuntimeKind: async () => 'cpa' };\n"
            version_path.write_text(source)

            CUSTOMIZATIONS.patch_runtime_detection(target)
            CUSTOMIZATIONS.flush_writes()

            self.assertEqual(version_path.read_text(), source)
            self.assertFalse((api_dir / 'client.ts').exists())


if __name__ == '__main__':
    unittest.main()
