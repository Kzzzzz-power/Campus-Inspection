// Coordinates describe the concept model, not a survey or live device telemetry.
// Canonical names/zone IDs are unchanged; displayName describes a separate conceptual volume.
export const CAMPUS_BUILDINGS = Object.freeze([
 {id:'teaching',name:'教学楼',displayName:'教学区 A · 围合庭院',position:[-12,0,10],size:[34,10],floors:5,floorHeight:3.65,zoneIds:['Z1'],entryPosition:[-12,1.65,16],conceptual:true},
 {id:'laboratory',name:'实训楼',displayName:'实验楼 · 独立示意',position:[-32,0,-16],size:[22,12],floors:3,floorHeight:4,zoneIds:['Z2'],entryPosition:[-32,1.65,-9],conceptual:true},
 {id:'training',name:'实训楼',displayName:'实训高楼 · 空间示意',position:[25,0,-9],size:[18,12],floors:7,floorHeight:3.65,zoneIds:['Z3'],entryPosition:[25,1.65,-2],conceptual:true},
]);
export const CAMPUS_LAYOUT = Object.freeze({
 C01:{position:[-24,5.65,15.25],entryPosition:[-12,1.65,16],facilityId:'lighting-201',zoneId:'Z1',sceneKind:'lighting',buildingId:'teaching',floorId:'2F'},
 C02:{position:[-12,5.65,4.75],entryPosition:[-12,1.65,16],facilityId:'hvac-2f',zoneId:'Z1',sceneKind:'hvac',buildingId:'teaching',floorId:'2F'},
 C03:{position:[5.25,5.65,10],entryPosition:[-12,1.65,16],facilityId:'ap-2f',zoneId:'Z1',sceneKind:'network',buildingId:'teaching',floorId:'2F'},
 C04:{position:[-43.25,2.4,-16],entryPosition:[-32,1.65,-9],facilityId:'lab-power-101',zoneId:'Z2',sceneKind:'power',buildingId:'laboratory',floorId:'1F'},
 C05:{position:[-32,2.4,-9.75],entryPosition:[-32,1.65,-9],facilityId:'access-101',zoneId:'Z2',sceneKind:'access',buildingId:'laboratory',floorId:'1F'},
 C06:{position:[-20.75,2.4,-18],entryPosition:[-32,1.65,-9],facilityId:'exhaust-101',zoneId:'Z2',sceneKind:'exhaust',buildingId:'laboratory',floorId:'1F'},
 C07:{position:[21,5.65,-2.75],entryPosition:[25,1.65,-2],facilityId:'switch-301',zoneId:'Z3',sceneKind:'rack',buildingId:'training',floorId:'2F'},
 C08:{position:[34.25,5.65,-12],entryPosition:[25,1.65,-2],facilityId:'hvac-301',zoneId:'Z3',sceneKind:'environment',buildingId:'training',floorId:'2F'},
});
export const CAMPUS_BOUNDS={min:[-55,0,-61],max:[48,31,44]};
