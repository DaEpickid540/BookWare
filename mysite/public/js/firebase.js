<script type="module">
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
  import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
  import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

  const firebaseConfig = {
    apiKey: "YOUR_KEY",
    authDomain: "bookware-site.firebaseapp.com",
    projectId: "bookware-site",
    storageBucket: "bookware-site.appspot.com",
    messagingSenderId: "...",
    appId: "..."
  };

  export const app = initializeApp(firebaseConfig);
  export const auth = getAuth(app);
  export const db = getFirestore(app);
</script>
