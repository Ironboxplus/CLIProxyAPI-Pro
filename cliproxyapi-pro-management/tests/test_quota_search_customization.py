import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / 'apply_customizations.py'
SPEC = importlib.util.spec_from_file_location('apply_customizations', MODULE_PATH)
assert SPEC and SPEC.loader
CUSTOMIZATIONS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CUSTOMIZATIONS)


QUOTA_PAGE_SOURCE = """import { useCallback, useEffect, useState } from 'react';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';

export function QuotaPage() {
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');

  const disableControls = false;

  return (
    <div>
      {error && <div className={styles.errorBox}>{error}</div>}
      <QuotaSection
        disabled={disableControls}
      />
    </div>
  );
}
"""


QUOTA_SECTION_SOURCE = """interface QuotaSectionProps<TState, TData> {
  disabled: boolean;
}

export function QuotaSection<TState, TData>({
  loading,
  disabled,
}: QuotaSectionProps<TState, TData>) {
  const filteredFiles = useMemo(
    () => files.filter((file) => config.filterFn(file)),
    [files, config]
  );

  useEffect(() => {
    if (filteredFiles.length === 0) {
      setQuota({});
      return;
    }
    setQuota((prev) => {
      const nextState: Record<string, TState> = {};
      filteredFiles.forEach((file) => {
        const cached = prev[file.name];
        if (cached) nextState[file.name] = cached;
      });
      return nextState;
    });
  }, [filteredFiles, loading, setQuota]);

  return (
    <Card
    />
  );
}
"""


class QuotaSearchCustomizationTest(unittest.TestCase):
    def setUp(self) -> None:
        CUSTOMIZATIONS._writes.clear()

    def test_adds_search_without_pruning_hidden_quota_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir)
            pages_dir = target / 'src/pages'
            quota_dir = target / 'src/components/quota'
            pages_dir.mkdir(parents=True)
            quota_dir.mkdir(parents=True)
            (pages_dir / 'QuotaPage.tsx').write_text(QUOTA_PAGE_SOURCE)
            (pages_dir / 'QuotaPage.module.scss').write_text('.errorBox {\n}\n')
            (quota_dir / 'QuotaSection.tsx').write_text(QUOTA_SECTION_SOURCE)

            CUSTOMIZATIONS.patch_quota_page_search(target)
            CUSTOMIZATIONS.flush_writes()

            page = (pages_dir / 'QuotaPage.tsx').read_text()
            section = (quota_dir / 'QuotaSection.tsx').read_text()
            styles = (pages_dir / 'QuotaPage.module.scss').read_text()

            self.assertIn('QUOTA_SEARCH_FIELD_KEYS', page)
            self.assertIn("value.split('*')", page)
            self.assertIn("placeholder={t('quota_management.search_placeholder')}", page)
            self.assertIn('searchFileNames={searchFileNames}', page)
            self.assertIn('hideWhenEmpty={Boolean(normalizedSearch)}', page)
            self.assertIn('const providerFiles = useMemo(', section)
            self.assertIn('providerFiles.forEach((file)', section)
            self.assertNotIn('filteredFiles.forEach((file)', section)
            self.assertIn('if (hideWhenEmpty && filteredFiles.length === 0) return null;', section)
            self.assertIn('.searchBar {', styles)

            CUSTOMIZATIONS.patch_quota_page_search(target)
            CUSTOMIZATIONS.flush_writes()
            self.assertEqual(page, (pages_dir / 'QuotaPage.tsx').read_text())
            self.assertEqual(section, (quota_dir / 'QuotaSection.tsx').read_text())


if __name__ == '__main__':
    unittest.main()
