// Configuración WEB de TAXI DJ registrada en Firebase.
// La clave web es pública; protege los datos con las reglas de Firestore.
export const firebaseConfig = {
  apiKey: "AIzaSyDpZHLDqKHX9xWIxbIV5y6LswcioAsTCyw",
  authDomain: "taxi-dj-47fa8.firebaseapp.com",
  projectId: "taxi-dj-47fa8",
  appId: "1:882185163293:web:e8136ab2a2ea76699fecf4"
};
export const isConfigured = !firebaseConfig.apiKey.startsWith("PON_AQUI");
