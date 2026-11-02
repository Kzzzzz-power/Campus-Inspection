"""Guard the cold-start comparison against accepting lost/mutated/duplicate proof."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest
from contextlib import closing
import sqlite3
from tempfile import TemporaryDirectory

SPEC = importlib.util.spec_from_file_location('coldstart', Path(__file__).with_name('stage08-coldstart.py'))
coldstart = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(coldstart)


class SnapshotChecks(unittest.TestCase):
    def setUp(self):
        self.snapshot = {'facility_observations': [{'observation_id': 'previous', 'source_type': 'SIMULATED'}],
                         **{table: [{'persisted': table}] for table in ('inspection_rounds', 'scenario_instances',
                             'run_evidence', 'dependency_checks', 'task_results', 'plan_results', 'blockers')},
                         'runs': [{'run_id': 'old', 'result_json': '{"frozen":true}'}],
                         'request_receipts': [{'request_id': 'proof', 'response_json': '{}'}],
                         'evidence': [{'evidence_id': 'proof', 'evidence_type': 'field_photo',
                                       'source_type': 'ON_SITE', 'review_id': 'review',
                                       'inspection_round_id': 'round', 'inspection_id': 'inspection',
                                       'observation_id': None}]}

    def test_fresh_unbound_simulator_evidence_is_allowed(self):
        actual = deepcopy(self.snapshot)
        actual['evidence'].append({'evidence_id': 'remote', 'evidence_type': 'facility_status',
                                  'source_type': 'SIMULATED', 'observation_id': 'observation',
                                  'review_id': None, 'inspection_round_id': None, 'inspection_id': None})
        actual['facility_observations'].append({'observation_id': 'observation', 'source_type': 'SIMULATED'})
        coldstart.compare_database_snapshots(self.snapshot, actual)

    def test_database_snapshot_includes_normalized_business_tables(self):
        tables = ('runs', 'run_snapshots', 'records', 'inspection_records', 'evidence', 'photos',
                  'request_receipts', 'reviews', 'review_runs', 'inspection_rounds', 'scenario_instances',
                  'run_evidence', 'dependency_checks', 'task_results', 'plan_results', 'blockers',
                  'facility_observations', 'run_references', 'legacy_runs')
        with TemporaryDirectory(dir=coldstart.RUNTIME) as directory:
            database = Path(directory) / 'test.db'
            with closing(sqlite3.connect(database)) as connection:
                for table in tables:
                    connection.execute(f'CREATE TABLE {table} (id TEXT PRIMARY KEY, value TEXT)')
                    connection.execute(f'INSERT INTO {table} VALUES (?,?)', ('saved', table))
                connection.commit()
            snapshot = coldstart.database_snapshot(database)
            self.assertEqual(set(snapshot), set(tables))
            for table in tables:
                self.assertEqual(snapshot[table], [{'id': 'saved', 'value': table}])

    def test_non_simulator_observation_cannot_appear_on_restart(self):
        actual = deepcopy(self.snapshot)
        actual['facility_observations'].append({'observation_id': 'unexpected', 'source_type': 'DEVICE'})
        with self.assertRaises(AssertionError):
            coldstart.compare_database_snapshots(self.snapshot, actual)

    def test_changed_or_lost_prior_rows_fail(self):
        for table in self.snapshot:
            for operation in ('mutate', 'delete'):
                with self.subTest(table=table, operation=operation):
                    actual = deepcopy(self.snapshot)
                    if operation == 'delete':
                        actual[table].clear()
                    else:
                        actual[table][0]['changed'] = True
                    with self.assertRaises(AssertionError):
                        coldstart.compare_database_snapshots(self.snapshot, actual)

    def test_duplicate_business_evidence_fails(self):
        actual = deepcopy(self.snapshot)
        actual['evidence'].append({**actual['evidence'][0], 'evidence_id': 'duplicate'})
        with self.assertRaises(AssertionError):
            coldstart.compare_database_snapshots(self.snapshot, actual)

    def test_remote_evidence_bound_to_business_scope_fails(self):
        for scope in ('review_id', 'inspection_round_id', 'inspection_id'):
            with self.subTest(scope=scope):
                actual = deepcopy(self.snapshot)
                actual['evidence'].append({'evidence_id': 'remote', 'evidence_type': 'facility_status',
                                          'source_type': 'SIMULATED', 'observation_id': 'observation',
                                          'review_id': None, 'inspection_round_id': None,
                                          'inspection_id': None, scope: 'unexpected'})
                with self.assertRaises(AssertionError):
                    coldstart.compare_database_snapshots(self.snapshot, actual)


if __name__ == '__main__':
    unittest.main()