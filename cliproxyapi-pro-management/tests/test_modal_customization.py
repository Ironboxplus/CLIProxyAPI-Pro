import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / 'apply_customizations.py'
SPEC = importlib.util.spec_from_file_location('apply_customizations', MODULE_PATH)
assert SPEC and SPEC.loader
CUSTOMIZATIONS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CUSTOMIZATIONS)


MODAL_SOURCE = """import { useEffect, useRef } from 'react';

export function Modal({ open }: { open: boolean }) {
  const [isVisible] = [false];
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open || isVisible) return;
    previouslyFocusedRef.current?.focus();
    previouslyFocusedRef.current = null;
  }, [isVisible, open]);

  return null;
}
"""

SCROLL_LOCK_SOURCE = """const MODAL_LOCK_CLASS = 'modal-open';

let activeLockCount = 0;

const snapshot = {
  scrollY: 0,
};

export function lockScroll(): void {
  body.style.position = 'fixed';
  body.style.width = '100%';
}

export function unlockScroll(): void {
  contentEl.scrollTo({ top: 0 });
  window.scrollTo({ top: snapshot.scrollY });
}

export const FOCUSABLE_SELECTOR = 'button';
"""

GLOBAL_STYLE_SOURCE = """@use './layout.scss';

html.modal-open,
body.modal-open {
  overflow: hidden;
}

body.modal-open .content {
  overflow: hidden;
}

body {
  color: var(--text-primary);
}
"""


class ModalCustomizationTest(unittest.TestCase):
    def setUp(self) -> None:
        CUSTOMIZATIONS._writes.clear()

    def test_restores_only_connected_trigger_without_scrolling(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir)
            modal_dir = target / 'src/components/ui'
            modal_dir.mkdir(parents=True)
            modal_path = modal_dir / 'Modal.tsx'
            modal_path.write_text(MODAL_SOURCE)

            CUSTOMIZATIONS.patch_modal_focus_restore(target)
            CUSTOMIZATIONS.flush_writes()

            patched = modal_path.read_text()
            self.assertIn('previouslyFocused?.isConnected', patched)
            self.assertIn('previouslyFocused.focus({ preventScroll: true });', patched)
            self.assertNotIn('previouslyFocusedRef.current?.focus();', patched)

            CUSTOMIZATIONS.patch_modal_focus_restore(target)
            CUSTOMIZATIONS.flush_writes()
            self.assertEqual(patched, modal_path.read_text())

    def test_scroll_lock_does_not_reflow_or_force_scroll_restore(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir)
            ui_dir = target / 'src/components/ui'
            ui_dir.mkdir(parents=True)
            scroll_lock_path = ui_dir / 'scrollLock.ts'
            scroll_lock_path.write_text(SCROLL_LOCK_SOURCE)

            CUSTOMIZATIONS.patch_modal_scroll_lock(target)
            CUSTOMIZATIONS.flush_writes()

            patched = scroll_lock_path.read_text()
            self.assertIn("body.style.overflow = 'hidden';", patched)
            self.assertIn("html.style.overflow = 'hidden';", patched)
            self.assertNotIn("body.style.position = 'fixed';", patched)
            self.assertNotIn("body.style.width = '100%';", patched)
            self.assertNotIn('scrollTo(', patched)

            CUSTOMIZATIONS.patch_modal_scroll_lock(target)
            CUSTOMIZATIONS.flush_writes()
            self.assertEqual(patched, scroll_lock_path.read_text())

    def test_modal_keeps_the_content_scrollbar_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir)
            styles_dir = target / 'src/styles'
            styles_dir.mkdir(parents=True)
            global_style_path = styles_dir / 'global.scss'
            global_style_path.write_text(GLOBAL_STYLE_SOURCE)

            CUSTOMIZATIONS.patch_modal_content_scrollbar_layout(target)
            CUSTOMIZATIONS.flush_writes()

            patched = global_style_path.read_text()
            self.assertIn('html.modal-open,\nbody.modal-open {\n  overflow: hidden;\n}', patched)
            self.assertNotIn('body.modal-open .content', patched)

            CUSTOMIZATIONS.patch_modal_content_scrollbar_layout(target)
            CUSTOMIZATIONS.flush_writes()
            self.assertEqual(patched, global_style_path.read_text())


if __name__ == '__main__':
    unittest.main()
