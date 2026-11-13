import { Route, Routes } from 'react-router-dom';
import { ComponentsDemo } from './pages/ComponentsDemo';
import { Home } from './pages/Home';
import { NotFound } from './pages/NotFound';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/demo/components" element={<ComponentsDemo />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
