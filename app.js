import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, setDoc, addDoc, onSnapshot, query, orderBy, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { firebaseConfig, isConfigured } from './firebase-config.js';
import { youtubeApiKey, youtubeReady } from './youtube-config.js';

const $ = id => document.getElementById(id);
const state = {
  auth: null, db: null, uid: null, roomId: null, room: null, guest: null,
  unsubs: [], songs: [], clock: null, joining: false, connected: false, ended: false, reordering: false
};
let toastTimer;

function toast(message) {
  const el = $('notice');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 4500);
}
function fail(e) {
  console.error(e);
  toast(e?.code === 'permission-denied' ? 'Sin permisos o sesión vencida.' : (e?.message || 'No se pudo completar la acción.'));
}
function show(id) {
  for (const section of ['entry', 'guestPanel', 'ended']) $(section).hidden = section !== id;
}
function cleanup() {
  state.unsubs.forEach(unsubscribe => unsubscribe());
  state.unsubs = [];
  clearInterval(state.clock);
  state.clock = null;
  state.guest = null;
  state.room = null;
  state.songs = [];
  state.connected = false;
}
function readRoomFromQr() {
  const fromUrl = new URLSearchParams(location.search).get('sala');
  if (fromUrl !== null) {
    const room = fromUrl.trim().toUpperCase();
    if (!/^[A-Z2-9]{8}$/.test(room)) return null;
    // Conservar el código internamente para actualizar la página y reconectarse.
    // Tras abrir el QR no se muestra el código en la barra de direcciones.
    try {
      sessionStorage.setItem('taxidj-passenger-room', room);
      history.replaceState(null, '', location.pathname + location.hash);
    } catch { /* Si se bloquea el almacenamiento, el QR original sigue funcionando. */ }
    return room;
  }
  try { return sessionStorage.getItem('taxidj-passenger-room'); }
  catch { return null; }
}
const qrRoom = readRoomFromQr();

// El nombre visible ES fecha y hora de ingreso. Firebase Auth UID es la identidad
// verdaderamente única y no se muestra. Un pasajero que regresa conserva el nombre.
function arrivalName() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}
function checkValid() {
  const g = state.guest, room = state.room;
  if (!g || !room || !room.active || g.blocked || g.left) return false;
  if (!g.joinedAt) return true;
  return g.minutes === 0 || Date.now() < g.joinedAt.toMillis() + (g.minutes + (g.extraMinutes || 0)) * 60000;
}
function endSession(title, message) {
  cleanup();
  state.ended = true;
  show('ended');
  $('endedTitle').textContent = title;
  $('endedMessage').textContent = message;
}
function tick() {
  const guest = state.guest, room = state.room;
  if (!guest || !room) return;
  if (!room.active) return endSession('La sala ha cerrado', 'Gracias por acompañarnos.');
  if (guest.blocked || guest.left) return endSession('Tu acceso ha finalizado', 'El conductor cerró tu sesión.');
  if (!guest.joinedAt) { $('remaining').textContent = 'Conectando…'; return; }
  if (guest.minutes === 0) { $('remaining').textContent = 'Sin límite'; return; }
  const remaining = guest.joinedAt.toMillis() + (guest.minutes + (guest.extraMinutes || 0)) * 60000 - Date.now();
  if (remaining <= 0) return endSession('Se terminó tu tiempo', 'Gracias por disfrutar TAXI DJ.');
  const seconds = Math.ceil(remaining / 1000);
  $('remaining').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function thumbnail(id) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '';
}
function orderedQueued() {
  const queued = state.songs.filter(song => song.status === 'queued');
  const order = Array.isArray(state.room?.queueOrder) ? state.room.queueOrder : [];
  const positions = new Map(order.map((id, i) => [id, i]));
  // Los temas nuevos que aún no aparecen en queueOrder mantienen el orden de llegada.
  return queued.sort((a, b) => {
    const ai = positions.has(a.id) ? positions.get(a.id) : Infinity;
    const bi = positions.has(b.id) ? positions.get(b.id) : Infinity;
    return ai - bi;
  });
}
function songRow(track, index) {
  const row = document.createElement('div');
  row.className = 'queue-song';
  row.dataset.songId = track.id;
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'drag-handle';
  handle.textContent = '⠿';
  const canReorder = state.room?.allowGuestControls === true && checkValid();
  handle.disabled = !canReorder;
  handle.title = canReorder ? 'Arrastra para reordenar (o usa flechas del teclado)' : 'Solo el conductor puede autorizar el cambio de orden';
  handle.setAttribute('aria-label', `Cambiar orden de ${track.title}. Posición ${index}`);
  if (canReorder) setupDragHandle(handle, row);
  const art = document.createElement('img');
  art.className = 'queue-cover';
  art.alt = 'Miniatura';
  if (thumbnail(track.videoId)) art.src = thumbnail(track.videoId);
  const info = document.createElement('div');
  info.className = 'song-meta';
  const title = document.createElement('strong');
  title.className = 'queue-title';
  title.textContent = track.title || 'Canción de YouTube';
  const author = document.createElement('small');
  author.className = 'queue-author';
  author.textContent = `Solicitada por ${track.addedByName || 'Pasajero'}`;
  info.append(title, author);
  const menu = document.createElement('details');
  menu.className = 'row-menu';
  const summary = document.createElement('summary');
  summary.setAttribute('aria-label', 'Opciones de canción');
  summary.textContent = '•••';
  const menuContent = document.createElement('div');
  menuContent.className = 'row-menu-actions';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = 'Copiar enlace';
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`https://www.youtube.com/watch?v=${track.videoId}`);
      toast('Enlace copiado.');
    } catch { toast('No se pudo copiar el enlace.'); }
    menu.open = false;
  });
  menuContent.append(copyButton);
  menu.append(summary, menuContent);
  row.append(handle, art, info, menu);
  return row;
}
// Reordenar en el navegador no basta: se envía una orden validada al APK del conductor.
// El conductor aplica el orden a Firestore y lo utiliza al pasar a la siguiente canción.
async function moveInQueue(fromId, targetId, direction) {
  if (state.reordering || fromId === targetId) return;
  if (!/^[a-zA-Z0-9]{20}$/.test(fromId) || !/^[a-zA-Z0-9]{20}$/.test(targetId)) return;
  state.reordering = true;
  try {
    await guestCommand('reorder', `${fromId}~${targetId}~${direction}`);
    toast('Orden solicitado. El conductor lo aplicará a la cola.');
  } catch (e) { fail(e); }
  finally {
    state.reordering = false;
    // Firestore notificará el orden confirmado por el administrador.
    setTimeout(renderSongs, 450);
  }
}
function setupDragHandle(handle, row) {
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || state.reordering) return;
    event.preventDefault();
    const list = $('songList');
    const initial = Array.from(list.querySelectorAll('[data-song-id]')).map(x => x.dataset.songId);
    row.classList.add('dragging');
    const pointerId = event.pointerId;
    let moved = false;
    const move = e => {
      if (e.pointerId !== pointerId) return;
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.queue-song[data-song-id]');
      if (!target || target === row || !list.contains(target)) return;
      moved = true;
      const targetMiddle = target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
      list.insertBefore(row, e.clientY < targetMiddle ? target : target.nextSibling);
    };
    const finish = e => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      row.classList.remove('dragging');
      if (!moved) return;
      const ids = Array.from(list.querySelectorAll('[data-song-id]')).map(x => x.dataset.songId);
      if (ids.join('|') === initial.join('|')) return;
      const index = ids.indexOf(row.dataset.songId);
      const target = ids[index + 1] || ids[index - 1];
      const direction = ids[index + 1] ? 'b' : 'a';
      moveInQueue(row.dataset.songId, target, direction).catch(fail);
    };
    const cancel = e => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      row.classList.remove('dragging');
      renderSongs();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  });
  handle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const ids = Array.from($('songList').querySelectorAll('[data-song-id]')).map(x => x.dataset.songId);
    const index = ids.indexOf(row.dataset.songId);
    const destination = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (destination < 0 || destination >= ids.length) return;
    moveInQueue(row.dataset.songId, ids[destination], event.key === 'ArrowUp' ? 'b' : 'a').catch(fail);
  });
}
function renderSongs() {
  const list = $('songList');
  // No interrumpir el movimiento mientras el pasajero arrastra una canción.
  if (list.querySelector('.dragging')) return;
  list.replaceChildren();
  const queued = orderedQueued();
  $('queueCount').textContent = `${queued.length} en espera`;
  $('queueHint').textContent = state.room?.allowGuestControls === true
    ? '⠿ Arrastra para ordenar hasta 5 próximos temas. El conductor mantiene el control.'
    : 'El conductor controla el orden de reproducción.';
  queued.slice(0, 5).forEach((song, i) => list.append(songRow(song, i + 1)));
  if (!list.children.length) {
    const p = document.createElement('p');
    p.className = 'muted empty';
    p.textContent = 'La cola está vacía. ¡Agrega el primer tema!';
    list.append(p);
  }
  if (queued.length > 5) {
    const note = document.createElement('p');
    note.className = 'queue-extra';
    note.textContent = `+ ${queued.length - 5} tema(s) en espera después de estos cinco.`;
    list.append(note);
  }
}
function displayRoom() {
  if (!state.room) return;
  $('roomName').textContent = state.room.title || 'TAXI DJ';
  $('currentSong').textContent = state.room.currentTitle || 'Esperando la primera canción';
  $('currentDetail').textContent = state.room.currentVideoId
    ? (state.room.isPaused ? 'En pausa · Suena en el taxi' : 'Sonando en el taxi')
    : 'Tu música comienza aquí';
  const playing = !!state.room.currentVideoId;
  $('cover').hidden = !playing;
  $('coverPlaceholder').hidden = playing;
  if (playing) $('cover').src = thumbnail(state.room.currentVideoId);
  const control = $('pauseResume');
  control.disabled = !playing || !checkValid() || state.room.allowGuestControls !== true;
  control.textContent = state.room.isPaused ? '▶' : '❚❚';
  control.setAttribute('aria-label', state.room.isPaused ? 'Reanudar' : 'Pausar');
  const vote = state.room.allowGuestVotes === true;
  $('skipTrack').disabled = !playing || !checkValid() || (!vote && state.room.allowGuestControls !== true);
  $('skipTrack').setAttribute('aria-label', vote ? 'Votar para saltar canción' : 'Siguiente canción');
  $('voteProgress').textContent = playing && vote
    ? `Votar para saltar · Votos: ${state.room.skipVoteCount || 0}/${state.room.skipVoteThreshold || 1}`
    : 'El conductor controla la reproducción';
  renderSongs();
  tick();
}
function showEntryError(message) {
  show('entry');
  $('entryMessage').textContent = message;
  $('retryButton').hidden = !qrRoom;
}
async function connectFromQr() {
  if (state.joining || state.connected || state.ended || !state.uid || !state.db) return;
  if (!qrRoom || !/^[A-Z2-9]{8}$/.test(qrRoom)) {
    showEntryError('Escanea el código QR que te muestra tu conductor para ingresar directamente a su sala.');
    return;
  }
  state.joining = true;
  $('entryMessage').textContent = 'Ingresando automáticamente a la sala…';
  $('retryButton').hidden = true;
  show('entry');
  try {
    const roomRef = doc(state.db, 'rooms', qrRoom);
    const room = await getDoc(roomRef);
    if (!room.exists() || !room.data().active) throw new Error('Esta sala no existe o ya cerró.');
    const guestRef = doc(state.db, 'rooms', qrRoom, 'guests', state.uid);
    const previous = await getDoc(guestRef);
    if (!previous.exists()) {
      await setDoc(guestRef, {
        uid: state.uid,
        displayName: arrivalName(),
        joinedAt: serverTimestamp(),
        minutes: room.data().defaultMinutes,
        extraMinutes: 0,
        blocked: false,
        left: false
      });
    } else {
      const guest = previous.data();
      if (guest.blocked || guest.left || (guest.minutes !== 0 && guest.joinedAt && Date.now() >= guest.joinedAt.toMillis() + (guest.minutes + (guest.extraMinutes || 0)) * 60000)) {
        throw new Error('Tu sesión ya terminó. Pide al conductor una nueva invitación.');
      }
    }
    cleanup();
    state.roomId = qrRoom;
    state.room = room.data();
    state.connected = true;
    state.unsubs.push(onSnapshot(roomRef, snapshot => {
      if (!snapshot.exists()) return endSession('Sala no disponible', 'El conductor cerró esta sala.');
      state.room = snapshot.data();
      displayRoom();
    }, fail));
    state.unsubs.push(onSnapshot(guestRef, snapshot => {
      if (!snapshot.exists()) return endSession('Sesión finalizada', 'Consulta al conductor.');
      state.guest = snapshot.data();
      displayRoom();
    }, fail));
    state.unsubs.push(onSnapshot(query(collection(state.db, 'rooms', qrRoom, 'songs'), orderBy('createdAt', 'asc')), snapshot => {
      state.songs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      renderSongs();
    }, fail));
    state.clock = setInterval(tick, 1000);
    show('guestPanel');
    displayRoom();
  } catch (error) {
    console.error(error);
    showEntryError(error?.message || 'No fue posible ingresar. Comprueba tu conexión.');
  } finally {
    state.joining = false;
  }
}
function resultRow(video) {
  const row = document.createElement('div');
  row.className = 'result-song';
  const art = document.createElement('img');
  art.className = 'result-cover';
  art.alt = 'Miniatura de YouTube';
  art.src = thumbnail(video.videoId);
  const meta = document.createElement('div');
  meta.className = 'song-meta';
  const title = document.createElement('strong');
  title.textContent = video.title;
  meta.append(title);
  if (video.artist) {
    const artist = document.createElement('small');
    artist.textContent = video.artist;
    meta.append(artist);
  }
  const actions = document.createElement('div');
  actions.className = 'result-actions';
  const queueButton = document.createElement('button');
  queueButton.type = 'button';
  queueButton.className = 'secondary';
  queueButton.textContent = '+ Cola';
  queueButton.addEventListener('click', () => requestVideo(video, false).catch(fail));
  actions.append(queueButton);
  row.append(art, meta, actions);
  return row;
}
async function searchYouTube() {
  const search = $('searchText').value.trim();
  if (search.length < 2) return toast('Escribe el nombre de una canción.');
  if (!youtubeReady) return toast('Falta configurar YouTube en youtube-config.js.');
  const list = $('searchResults');
  list.replaceChildren();
  const wait = document.createElement('p');
  wait.className = 'muted';
  wait.textContent = 'Buscando canciones…';
  list.append(wait);
  const api = new URL('https://www.googleapis.com/youtube/v3/search');
  for (const [k, v] of Object.entries({part:'snippet',type:'video',videoEmbeddable:'true',maxResults:'8',q:search,key:youtubeApiKey})) api.searchParams.set(k, v);
  try {
    const response = await fetch(api);
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || 'Error de búsqueda de YouTube.');
    list.replaceChildren();
    for (const item of data.items || []) list.append(resultRow({videoId:item.id.videoId,title:item.snippet.title,artist:item.snippet.channelTitle}));
    if (!data.items?.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No encontramos resultados. Prueba otra búsqueda.';
      list.append(empty);
    }
  } catch (error) {
    fail(error);
    list.replaceChildren();
  }
}
async function guestCommand(action, songId = '') {
  if (!checkValid() || (action === 'vote_skip' ? state.room?.allowGuestVotes !== true : state.room?.allowGuestControls !== true)) {
    throw new Error('El conductor no ha autorizado este control.');
  }
  await addDoc(collection(state.db, 'rooms', state.roomId, 'commands'), {
    action, songId, uid: state.uid, processed: false, createdAt: serverTimestamp()
  });
}
async function requestVideo(video, playNow) {
  if (!checkValid() || !state.room?.allowRequests) throw new Error('No se permiten solicitudes en este momento.');
  if (state.room.blockDuplicates !== false && state.songs.some(song => song.videoId === video.videoId && ['queued', 'playing'].includes(song.status))) {
    throw new Error('Esta canción ya está en la cola o reproduciéndose.');
  }
  const songRef = await addDoc(collection(state.db, 'rooms', state.roomId, 'songs'), {
    title: video.title.slice(0, 100),
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    videoId: video.videoId,
    addedBy: state.uid,
    addedByName: state.guest.displayName,
    status: 'queued',
    createdAt: serverTimestamp()
  });
  if (playNow) {
    if (state.room.allowGuestControls !== true) return toast('Añadida a la cola. El conductor controla Play.');
    await guestCommand('play', songRef.id);
    toast('▶ Reproducción solicitada.');
  } else toast('♫ Agregada a la cola.');
}
function idFromUrl(raw) {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    if (['youtube.com','m.youtube.com','music.youtube.com'].includes(host)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.split('/')[2];
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}
async function manualSong(event) {
  event.preventDefault();
  const videoId = idFromUrl($('manualUrl').value);
  if (!videoId) return toast('Enlace de YouTube inválido.');
  const title = $('manualTitle').value.trim();
  if (title.length < 2) return toast('Escribe el título.');
  await requestVideo({ videoId, title }, false);
  $('manualUrl').value = '';
  $('manualTitle').value = '';
}
$('showSearch').addEventListener('click', () => {
  const panel = $('searchPanel');
  panel.hidden = !panel.hidden;
  $('showSearch').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) {
    $('searchText').focus({preventScroll:true});
    requestAnimationFrame(() => panel.scrollIntoView({block:'nearest',behavior:'smooth'}));
  }
});
$('retryButton').addEventListener('click', () => connectFromQr().catch(fail));
$('manualSongForm').addEventListener('submit', event => manualSong(event).catch(fail));
$('searchButton').addEventListener('click', () => searchYouTube().catch(fail));
$('searchText').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); searchYouTube().catch(fail); }
});
$('pauseResume').addEventListener('click', () => guestCommand(state.room?.isPaused ? 'resume' : 'pause').then(() => toast('Orden enviada al conductor.')).catch(fail));
$('skipTrack').addEventListener('click', () => {
  const vote = state.room?.allowGuestVotes === true;
  const songId = vote ? (state.room?.currentSongId || '') : '';
  if (vote && !songId) return toast('Todavía no hay música sonando.');
  guestCommand(vote ? 'vote_skip' : 'next', songId)
    .then(() => toast(vote ? 'Voto enviado. Cambiaremos de canción al alcanzar la mayoría.' : 'Siguiente canción solicitada.'))
    .catch(fail);
});
$('leaveButton').addEventListener('click', () => endSession('Saliste de la sala', 'Tu tiempo continúa hasta que venza. Puedes volver mientras siga activo.'));
$('restartButton').addEventListener('click', () => { state.ended = false; connectFromQr().catch(fail); });

if (!isConfigured) showEntryError('La web requiere configurar Firebase para poder conectar.');
else {
  try {
    const app = initializeApp(firebaseConfig);
    state.auth = getAuth(app);
    state.db = getFirestore(app);
    onAuthStateChanged(state.auth, async user => {
      if (user) {
        state.uid = user.uid;
        connectFromQr().catch(fail);
        return;
      }
      try {
        const credentials = await signInAnonymously(state.auth);
        state.uid = credentials.user.uid;
        connectFromQr().catch(fail);
      } catch (error) { fail(error); showEntryError('No fue posible iniciar la conexión. Comprueba tu internet.'); }
    });
  } catch (error) { fail(error); showEntryError('No fue posible iniciar TAXI DJ.'); }
}
