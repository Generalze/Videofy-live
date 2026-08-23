import wrtc from '@roamhq/wrtc';
const { RTCPeerConnection, MediaStream, nonstandard } = wrtc;
const pc = new RTCPeerConnection({});
const src = new nonstandard.RTCVideoSource();
const track = src.createTrack();
pc.addTrack(track, new MediaStream([track]));
try {
  await pc.setLocalDescription();           // implicit form the mesh uses
  console.log('implicit setLocalDescription(): SUPPORTED');
  console.log('  localDescription type:', pc.localDescription?.type);
} catch (error) {
  console.log('implicit setLocalDescription(): THROWS ->', error?.message ?? error);
}
try {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);      // explicit form
  console.log('explicit setLocalDescription(offer): SUPPORTED');
} catch (error) {
  console.log('explicit setLocalDescription(offer): THROWS ->', error?.message ?? error);
}
pc.close();
