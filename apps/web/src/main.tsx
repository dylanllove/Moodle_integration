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
import { Setup } from "./pages/Setup.js";
import { Workload } from "./pages/Workload.js";
import { Materials } from "./pages/Materials.js";
import { Grades } from "./pages/Grades.js";
import { Flashcards } from "./pages/Flashcards.js";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "calendar", element: <Calendar /> },
      { path: "workload", element: <Workload /> },
      { path: "courses", element: <Courses /> },
      { path: "materials", element: <Materials /> },
      { path: "lectures", element: <Lectures /> },
      { path: "notes", element: <Notes /> },
      { path: "flashcards", element: <Flashcards /> },
      { path: "grades", element: <Grades /> },
      { path: "assistant", element: <Assistant /> },
      { path: "settings", element: <Settings /> },
      { path: "setup", element: <Setup /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
