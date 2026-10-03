-- Two signed-in people for the migrations after 0002: one whose token
-- carried a upn, one whose did not.
INSERT INTO app_user (tid, oid, display_name, upn) VALUES
  ('8f6c1a2e-0b7d-4c3e-9a51-2d4e6f708192', '1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b', 'Fixture Teacher', 'teacher@schule.example.org'),
  ('8f6c1a2e-0b7d-4c3e-9a51-2d4e6f708192', '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c', 'Fixture Witness', NULL);
