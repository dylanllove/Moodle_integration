import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import { Layout } from "./Layout.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Calendar } from "./pages/Calendar.js";
import { Courses } from "./pages/Courses.js";
import { Lectures } from "./pages/Lectures.js";
import { Notes } from "./pages/Notes.js";
import { Assistant } from "./pages/Assistant.js";
import { Settings } from "./pages/Settings.js";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "calendar", element: <Calendar /> },
      { path: "courses", element: <Courses /> },
      { path: "lectures", element: <Lectures /> },
      { path: "notes", element: <Notes /> },
      { path: "assistant", element: <Assistant /> },
      { path: "settings", element: <Settings /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
