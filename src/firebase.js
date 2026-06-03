import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBc-HbFx5icPOn_k1cBdv-8ASJYTIdZ-Bg",
  authDomain: "visionx-portfoliotracker.firebaseapp.com",
  projectId: "visionx-portfoliotracker",
  storageBucket: "visionx-portfoliotracker.firebasestorage.app",
  messagingSenderId: "1093434401072",
  appId: "1:1093434401072:web:c1b8065c447245490d68f5",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
