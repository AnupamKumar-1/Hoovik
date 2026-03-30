import './App.css';
import { Route, BrowserRouter as Router, Routes, Navigate } from 'react-router-dom';
import LandingPage from './pages/landing';
import Authentication from './pages/authentication';
import { AuthProvider } from './contexts/AuthContext';
import VideoMeetComponent from './pages/VideoMeet';
import HomeComponent from './pages/home';
import History from './pages/history';

// 🔐 Protected Route
const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem("token");

  if (!token || token === "undefined" || token === "null") {
    return <Navigate to="/auth" replace />;
  }

  return children;
};

function App() {
  return (
    <div className="App">
      <Router>
        <AuthProvider>
          <Routes>

            {/* ✅ Landing */}
            <Route path="/" element={<LandingPage />} />

            {/* ✅ Auth */}
            <Route path="/auth" element={<Authentication />} />

            {/* 🔥 PROTECTED ROUTES */}
            <Route
              path="/home"
              element={
                <ProtectedRoute>
                  <HomeComponent />
                </ProtectedRoute>
              }
            />

            <Route
              path="/history"
              element={
                <ProtectedRoute>
                  <History />
                </ProtectedRoute>
              }
            />

            <Route
              path="/room/:roomId"
              element={
                <ProtectedRoute>
                  <VideoMeetComponent />
                </ProtectedRoute>
              }
            />

            {/* ✅ Catch-all (IMPORTANT) */}
            <Route path="*" element={<Navigate to="/" replace />} />

          </Routes>
        </AuthProvider>
      </Router>
    </div>
  );
}

export default App;