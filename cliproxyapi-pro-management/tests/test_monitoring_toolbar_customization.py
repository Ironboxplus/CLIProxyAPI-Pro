import unittest
from pathlib import Path


PAGE_PATH = (
    Path(__file__).resolve().parents[1]
    / 'overlay/src/pages/MonitoringCenterPage.tsx'
)


class MonitoringToolbarCustomizationTest(unittest.TestCase):
    def test_monitoring_settings_button_keeps_a_stable_label_while_loading(self) -> None:
        source = PAGE_PATH.read_text()
        handler = 'onClick={() => void loadMonitoringSettings()}'
        start = source.index(handler)
        end = source.index('</button>', start)
        button = source[start:end]

        self.assertIn('disabled={isMonitoringSettingsLoading}', button)
        self.assertIn('aria-busy={isMonitoringSettingsLoading}', button)
        self.assertIn("{t('usage_stats.monitoring_settings')}", button)
        self.assertNotIn("isMonitoringSettingsLoading ? t('common.loading')", button)


if __name__ == '__main__':
    unittest.main()
