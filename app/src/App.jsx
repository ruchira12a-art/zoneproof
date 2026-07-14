import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Landing from './pages/Landing.jsx';
import MapPage from './pages/MapPage.jsx';
import VerifyPage from './pages/VerifyPage.jsx';
import TechPage from './pages/TechPage.jsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/map" element={<MapPage />} />
        <Route path="/verify/:hash" element={<VerifyPage />} />
        <Route path="/tech" element={<TechPage />} />
      </Routes>
    </BrowserRouter>
  );
}
