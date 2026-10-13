import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, setDoc, addDoc, onSnapshot, query, orderBy, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { firebaseConfig, isConfigured } from './firebase-config.js';

const $ = id => document.getElementById(id);
const state = { auth:null, db:null, roomId:null, room:null, guest:null, uid:null, unsubs:[], songs:[], clock:null };
let toastTimer;
function toast(message){const el=$('notice');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),4500)}
function fail(e){console.error(e);toast(e?.code==='permission-denied'?'Sin permisos o sesión vencida.':(e?.message||'No se pudo completar la acción.'))}
function show(id){for(const name of ['entry','guestPanel','ended'])$(name).hidden=name!==id}
function cleanup(){state.unsubs.forEach(f=>f());state.unsubs=[];clearInterval(state.clock);state.guest=null;state.room=null;state.songs=[]}
function videoIdFrom(input){try{const u=new URL(input.trim());const h=u.hostname.replace(/^www\./,'').toLowerCase();let id=null;if(h==='youtu.be') id=u.pathname.slice(1).split('/')[0];if(['youtube.com','m.youtube.com','music.youtube.com'].includes(h)){if(u.pathname==='/watch') id=u.searchParams.get('v');if(u.pathname.startsWith('/shorts/')||u.pathname.startsWith('/embed/')) id=u.pathname.split('/')[2]}return /^[a-zA-Z0-9_-]{11}$/.test(id||'')?id:null}catch{return null}}
function checkValid(){const g=state.guest,room=state.room;if(!g||!room||!room.active||g.blocked||g.left)return false;if(!g.joinedAt)return true;return g.minutes===0 || Date.now() < g.joinedAt.toMillis()+(g.minutes+g.extraMinutes)*60000}
function endSession(title,message){cleanup();show('ended');$('endedTitle').textContent=title;$('endedMessage').textContent=message}
function tick(){const g=state.guest,room=state.room;if(!g||!room)return;if(!room.active)return endSession('La sala ha cerrado','Gracias por acompañarnos.');if(g.blocked||g.left)return endSession('Tu acceso ha finalizado','El conductor cerró tu sesión.');if(!g.joinedAt){$('remaining').textContent='Conectando…';return}if(g.minutes===0){$('remaining').textContent='Sin límite';return}const remaining=g.joinedAt.toMillis()+(g.minutes+g.extraMinutes)*60000-Date.now();if(remaining<=0){endSession('Se terminó tu tiempo','Gracias por disfrutar TAXI DJ.');return}const secs=Math.ceil(remaining/1000);$('remaining').textContent=`${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`}
function makeSong(title,artist){const row=document.createElement('div');row.className='song';const icon=document.createElement('span');icon.className='song-icon';icon.textContent='♫';const meta=document.createElement('div');meta.className='song-meta';const strong=document.createElement('strong');strong.textContent=title;const small=document.createElement('small');small.textContent=artist;meta.append(strong,small);row.append(icon,meta);return row}
function renderSongs(){const list=$('songList');list.replaceChildren();const queued=state.songs.filter(s=>s.status==='queued');$('queueCount').textContent=String(queued.length);if(!queued.length){const p=document.createElement('p');p.className='muted';p.textContent='Todavía no hay canciones en espera.';list.append(p)}else queued.forEach(s=>list.append(makeSong(s.title,`Solicitada por ${s.addedByName}`)))}
function displayRoom(){if(!state.room)return;$('roomName').textContent=state.room.title||'TAXI DJ';$('codeLabel').textContent=`SALA ${state.roomId}`;$('currentSong').textContent=state.room.currentTitle||'Esperando la primera canción';$('currentDetail').textContent=state.room.currentVideoId?'Escúchala desde los parlantes del taxi':'¡Sé el primero en pedir música!';$('addSongButton').disabled=!checkValid()||!state.room.allowRequests;tick()}
async function join(e){e.preventDefault();if(!state.uid)return toast('Todavía estamos conectando…');const roomId=$('roomCode').value.trim().toUpperCase();const name=$('nickname').value.trim();if(!/^[A-Z2-9]{8}$/.test(roomId))return toast('Ingresa el código de 8 caracteres.');if(name.length<2)return toast('Escribe tu nombre (mínimo 2 letras).');$('joinButton').disabled=true;try{
 const ref=doc(state.db,'rooms',roomId);const snap=await getDoc(ref);if(!snap.exists()||!snap.data().active)throw new Error('Esta sala no existe o ya cerró.');
 const guestRef=doc(state.db,'rooms',roomId,'guests',state.uid);const old=await getDoc(guestRef);
 if(!old.exists())await setDoc(guestRef,{uid:state.uid,displayName:name,joinedAt:serverTimestamp(),minutes:snap.data().defaultMinutes,extraMinutes:0,blocked:false,left:false});
 else if(old.data().blocked||old.data().left|| (old.data().minutes!==0 && old.data().joinedAt && Date.now()>=old.data().joinedAt.toMillis()+(old.data().minutes+old.data().extraMinutes)*60000))throw new Error('Tu sesión ya terminó. Pide al conductor una nueva invitación.');
 cleanup();state.roomId=roomId;state.room=snap.data();$('nickname').value=name;
 state.unsubs.push(onSnapshot(ref,s=>{if(!s.exists())return endSession('Sala no disponible','El conductor cerró esta sala.');state.room=s.data();displayRoom()},fail));
 state.unsubs.push(onSnapshot(guestRef,s=>{if(!s.exists())return endSession('Sesión finalizada','Consulta al conductor.');state.guest=s.data();displayRoom()},fail));
 state.unsubs.push(onSnapshot(query(collection(state.db,'rooms',roomId,'songs'),orderBy('createdAt','asc')),s=>{state.songs=s.docs.map(d=>({id:d.id,...d.data()}));renderSongs()},fail));
 state.clock=setInterval(tick,1000);show('guestPanel');displayRoom();
 }catch(err){fail(err)}finally{$('joinButton').disabled=false}}
async function requestSong(e){e.preventDefault();if(!checkValid()||!state.room.allowRequests)return toast('No puedes solicitar canciones en este momento.');const videoId=videoIdFrom($('songUrl').value);if(!videoId)return toast('Utiliza un enlace válido de YouTube.');const title=$('songTitle').value.trim();if(title.length<2||title.length>100)return toast('Escribe el nombre de la canción.');const button=$('addSongButton');button.disabled=true;try{await addDoc(collection(state.db,'rooms',state.roomId,'songs'),{title,url:`https://www.youtube.com/watch?v=${videoId}`,videoId,addedBy:state.uid,addedByName:state.guest.displayName,status:'queued',createdAt:serverTimestamp()});$('songUrl').value='';$('songTitle').value='';toast('¡Canción agregada a la cola!')}catch(e){fail(e)}finally{button.disabled=false}}
$('joinForm').addEventListener('submit',join);
$('songForm').addEventListener('submit',requestSong);
$('searchButton').addEventListener('click',()=>{const t=$('searchText').value.trim();if(t)window.open('https://www.youtube.com/results?search_query='+encodeURIComponent(t),'_blank','noopener,noreferrer');else toast('Escribe el nombre de una canción.')});
$('leaveButton').addEventListener('click',()=>endSession('Saliste de la sala','Tu tiempo continúa hasta que venza. Puedes volver mientras siga activo.'));
$('restartButton').addEventListener('click',()=>show('entry'));
const code=new URLSearchParams(location.search).get('sala');if(code)$('roomCode').value=code.toUpperCase().slice(0,8);
if(!isConfigured)toast('La aplicación requiere configurar Firebase antes de publicarla.');
else try{const app=initializeApp(firebaseConfig);state.auth=getAuth(app);state.db=getFirestore(app);onAuthStateChanged(state.auth,async user=>{if(user){state.uid=user.uid;return}try{const r=await signInAnonymously(state.auth);state.uid=r.user.uid}catch(e){fail(e)}})}catch(e){fail(e)}
