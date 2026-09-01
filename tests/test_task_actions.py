from __future__ import annotations

import unittest

from ugc_image_tool.generation import GenerationStatus
from ugc_image_tool.ui.task_actions import PrimaryTaskAction, task_action_policy


class TaskActionPolicyTests(unittest.TestCase):
    def test_all_statuses_map_to_primary_action_without_a_result(self) -> None:
        expected = {
            GenerationStatus.QUEUED: PrimaryTaskAction.CANCEL,
            GenerationStatus.RUNNING: PrimaryTaskAction.CANCEL,
            GenerationStatus.SUCCEEDED: PrimaryTaskAction.REMOVE,
            GenerationStatus.PARTIALLY_SUCCEEDED: PrimaryTaskAction.REMOVE,
            GenerationStatus.FAILED: PrimaryTaskAction.REMOVE,
            GenerationStatus.UNKNOWN: PrimaryTaskAction.REMOVE,
            GenerationStatus.CANCELLED: PrimaryTaskAction.REMOVE,
        }

        for status, primary in expected.items():
            with self.subTest(status=status):
                policy = task_action_policy(status, has_usable_result=False)
                self.assertEqual(primary, policy.primary)
                self.assertFalse(policy.show_result_actions)
                self.assertEqual(
                    status not in {GenerationStatus.QUEUED, GenerationStatus.RUNNING},
                    policy.allow_removal,
                )

    def test_active_task_with_result_keeps_cancel_and_result_actions(self) -> None:
        for status in (GenerationStatus.QUEUED, GenerationStatus.RUNNING):
            with self.subTest(status=status):
                policy = task_action_policy(status, has_usable_result=True)
                self.assertEqual(PrimaryTaskAction.CANCEL, policy.primary)
                self.assertTrue(policy.show_result_actions)
                self.assertFalse(policy.allow_removal)

    def test_terminal_task_with_result_can_copy_and_be_removed(self) -> None:
        for status in (
            GenerationStatus.SUCCEEDED,
            GenerationStatus.PARTIALLY_SUCCEEDED,
            GenerationStatus.FAILED,
            GenerationStatus.UNKNOWN,
            GenerationStatus.CANCELLED,
        ):
            with self.subTest(status=status):
                policy = task_action_policy(status, has_usable_result=True)
                self.assertEqual(PrimaryTaskAction.COPY_RESULT, policy.primary)
                self.assertTrue(policy.show_result_actions)
                self.assertTrue(policy.allow_removal)


if __name__ == "__main__":
    unittest.main()
