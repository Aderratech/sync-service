/**
 * Local development data, for the Docker database only (never Azure):
 *
 * - Places: the same TEST places, ids and approximate centres as the portal's
 *   Fabric seed (portal fabric/seed/aderra_seed.py), so local and live test
 *   data line up. Real woreda names; ids are test ids, not official codes.
 * - A test vet covering every woreda, so reports are never refused
 *   NO_VET_ASSIGNED locally.
 * - reference_version rows, so /changes sends the reference lists.
 */

const REGIONS = [[1, 'Oromia'], [2, 'Amhara'], [3, 'Addis Ababa']];
const ZONES = [[101, 1, 'East Shewa'], [102, 1, 'Oromia Special Zone'], [201, 2, 'North Shewa'], [301, 3, 'Addis Ababa']];
// woreda_id, zone_id, name, approximate centre
const WOREDAS = [
  [1001, 101, "Ada'a", 8.752, 38.985], [1002, 101, 'Lume', 8.625, 39.12], [1003, 101, 'Adama', 8.545, 39.27],
  [1004, 101, 'Bora', 8.42, 38.955], [1005, 101, 'Dugda', 8.155, 38.815], [1006, 101, 'Gimbichu', 8.96, 39.105],
  [1007, 102, 'Akaki', 8.835, 38.85], [1008, 102, 'Sululta', 9.185, 38.755], [1009, 102, 'Sebeta Hawas', 8.915, 38.62],
  [1010, 102, 'Welmera', 9.045, 38.505], [1011, 102, 'Berek', 9.15, 39.03], [1012, 201, 'Basona Werana', 9.68, 39.53],
  [1013, 201, 'Ankober', 9.58, 39.73], [1014, 201, 'Kewet', 10.0, 39.88], [1015, 301, 'Bole', 8.99, 38.8],
  [1016, 301, 'Akaki Kality', 8.885, 38.78],
];
const KEBELES_PER_WOREDA = 7;

export const TEST_VET = { email: 'yonas.vet@aderra.test', name: 'Dr. Yonas' };

const REFERENCE_TABLES = ['region', 'zone', 'woreda', 'kebele', 'animal_type', 'produce_type', 'sign', 'disease', 'quick_response'];

const q = (s) => `N'${String(s).replace(/'/g, "''")}'`;

export function devSeedSql() {
  const regions = REGIONS.map(([id, name]) => `(${id}, ${q(name)})`).join(',');
  const zones = ZONES.map(([id, region, name]) => `(${id}, ${region}, ${q(name)})`).join(',');
  const woredas = WOREDAS.map(([id, zone, name]) => `(${id}, ${zone}, ${q(name)})`).join(',');
  // Kebele centroids: a small, fixed offset around the woreda centre, for the offline nearest-kebele lookup.
  const kebeles = WOREDAS.flatMap(([id, , , lat, lon]) =>
    Array.from({ length: KEBELES_PER_WOREDA }, (_, i) => {
      const k = i + 1;
      const angle = (2 * Math.PI * i) / KEBELES_PER_WOREDA;
      return `(${id * 100 + k}, ${id}, ${q(`Kebele ${String(k).padStart(2, '0')}`)}, ${(lat + 0.04 * Math.sin(angle)).toFixed(6)}, ${(lon + 0.04 * Math.cos(angle)).toFixed(6)})`;
    }),
  ).join(',');

  return `
MERGE dbo.region AS t USING (VALUES ${regions}) AS s(region_id, name_en) ON t.region_id = s.region_id
  WHEN MATCHED THEN UPDATE SET name_en = s.name_en WHEN NOT MATCHED THEN INSERT (region_id, name_en) VALUES (s.region_id, s.name_en);
MERGE dbo.zone AS t USING (VALUES ${zones}) AS s(zone_id, region_id, name_en) ON t.zone_id = s.zone_id
  WHEN MATCHED THEN UPDATE SET name_en = s.name_en WHEN NOT MATCHED THEN INSERT (zone_id, region_id, name_en) VALUES (s.zone_id, s.region_id, s.name_en);
MERGE dbo.woreda AS t USING (VALUES ${woredas}) AS s(woreda_id, zone_id, name_en) ON t.woreda_id = s.woreda_id
  WHEN MATCHED THEN UPDATE SET name_en = s.name_en WHEN NOT MATCHED THEN INSERT (woreda_id, zone_id, name_en) VALUES (s.woreda_id, s.zone_id, s.name_en);
MERGE dbo.kebele AS t USING (VALUES ${kebeles}) AS s(kebele_id, woreda_id, name_en, lat, lon) ON t.kebele_id = s.kebele_id
  WHEN MATCHED THEN UPDATE SET name_en = s.name_en, lat = s.lat, lon = s.lon
  WHEN NOT MATCHED THEN INSERT (kebele_id, woreda_id, name_en, lat, lon) VALUES (s.kebele_id, s.woreda_id, s.name_en, s.lat, s.lon);

IF NOT EXISTS (SELECT 1 FROM dbo.app_user WHERE email = ${q(TEST_VET.email)})
  INSERT dbo.app_user (identity_provider, identity_subject, email, name, language, role, origin)
  VALUES ('entra', ${q(TEST_VET.email)}, ${q(TEST_VET.email)}, ${q(TEST_VET.name)}, 'en', 'vet', 'seed');
DECLARE @vet UNIQUEIDENTIFIER = (SELECT user_id FROM dbo.app_user WHERE email = ${q(TEST_VET.email)});
INSERT dbo.vet_farm (vet_user_id, vet_email, woreda_id, valid_from)
SELECT @vet, ${q(TEST_VET.email)}, w.woreda_id, '2026-01-01' FROM dbo.woreda w
WHERE NOT EXISTS (SELECT 1 FROM dbo.vet_farm v WHERE v.woreda_id = w.woreda_id AND v.vet_user_id = @vet);

MERGE dbo.reference_version AS t
USING (VALUES ${REFERENCE_TABLES.map((name) => `('${name}')`).join(',')}) AS s(table_name) ON t.table_name = s.table_name
WHEN NOT MATCHED THEN INSERT (table_name, version) VALUES (s.table_name, 1);`;
}
