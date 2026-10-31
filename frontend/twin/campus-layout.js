// Coordinates describe the concept model, not a survey or live device telemetry.
// Canonical names/zone IDs are unchanged; displayName describes a separate conceptual volume.
export const CAMPUS_BUILDINGS = Object.freeze([
  { id: 'teaching', name: '教学楼', displayName: '教学楼', position: [-14, 0, -6], size: [23, 11], floors: 2, floorHeight: 3.65, zoneIds: ['Z1'], entryPosition: [-14, 1.65, 1], conceptual: true },
  { id: 'laboratory', name: '实训楼', displayName: '实验空间 · 独立示意', position: [12, 0, 6], size: [17, 9], floors: 1, floorHeight: 4.5, zoneIds: ['Z2'], entryPosition: [12, 1.65, 12], conceptual: true },
  { id: 'training', name: '实训楼', displayName: '实训楼 · 独立示意', position: [13, 0, -13], size: [19, 10], floors: 2, floorHeight: 3.8, zoneIds: ['Z3'], entryPosition: [13, 1.65, -6.5], conceptual: true },
]);
export const CAMPUS_LAYOUT = Object.freeze({
  C01: { position: [-22, 5.65, 0.12], entryPosition: [-14, 1.65, 1], facilityId: 'lighting-201', zoneId: 'Z1', sceneKind: 'lighting', buildingId: 'teaching', floorId: '2F' },
  C02: { position: [-14, 5.65, 0.12], entryPosition: [-14, 1.65, 1], facilityId: 'hvac-2f', zoneId: 'Z1', sceneKind: 'hvac', buildingId: 'teaching', floorId: '2F' },
  C03: { position: [-6, 5.65, 0.12], entryPosition: [-14, 1.65, 1], facilityId: 'ap-2f', zoneId: 'Z1', sceneKind: 'network', buildingId: 'teaching', floorId: '2F' },
  C04: { position: [5.5, 2.4, 11.12], entryPosition: [12, 1.65, 12], facilityId: 'lab-power-101', zoneId: 'Z2', sceneKind: 'power', buildingId: 'laboratory', floorId: '1F' },
  C05: { position: [12, 2.4, 11.12], entryPosition: [12, 1.65, 12], facilityId: 'access-101', zoneId: 'Z2', sceneKind: 'access', buildingId: 'laboratory', floorId: '1F' },
  C06: { position: [18.5, 2.4, 11.12], entryPosition: [12, 1.65, 12], facilityId: 'exhaust-101', zoneId: 'Z2', sceneKind: 'exhaust', buildingId: 'laboratory', floorId: '1F' },
  C07: { position: [7.8, 5.8, -7.38], entryPosition: [13, 1.65, -6.5], facilityId: 'switch-301', zoneId: 'Z3', sceneKind: 'rack', buildingId: 'training', floorId: '2F' },
  C08: { position: [18.2, 5.8, -7.38], entryPosition: [13, 1.65, -6.5], facilityId: 'hvac-301', zoneId: 'Z3', sceneKind: 'environment', buildingId: 'training', floorId: '2F' },
});

