# SalesFlow API

**Smart CRM & Sales Management REST API**

SalesFlow is a backend application designed to help small and medium-sized businesses manage their sales operations, customer relationships, and business workflows through a structured and scalable REST API.

The platform aims to simplify lead management, customer tracking, sales pipeline management, task scheduling, and sales performance monitoring.

> **Project Status:** Under Development 🚧

---

## Overview

SalesFlow provides a centralized backend for managing the complete sales lifecycle, from capturing potential customers to converting leads into deals and tracking sales performance.

The system is being designed with modular architecture, secure authentication, role-based access control, database integrity, and asynchronous background processing.

## Planned Features

- Authentication and Authorization (JWT).
- Role-Based Access Control (RBAC).
- User and Permission Management.
- Company and Contact Management.
- Lead Management and Assignment.
- Lead Qualification and Conversion.
- Deal and Sales Pipeline Management.
- Task and Follow-up Management.
- Activity Tracking.
- In-App Notifications.
- Audit Logging.
- Sales Reports and Analytics.
- CSV Bulk Lead Import.
- Background Job Processing.

*Features will be implemented incrementally.*

## Tech Stack

| Technology | Purpose |
|---|---|
| NestJS | Backend Framework |
| TypeScript | Programming Language |
| PostgreSQL | Relational Database |
| Prisma | ORM & Database Migrations |
| Redis | In-Memory Data Store |
| BullMQ | Background Job Processing |
| Docker | Containerization |
| pnpm | Package Management |
| Vitest | Unit Testing |
| Supertest | API E2E Testing |
| Swagger | API Documentation |
| ESLint | Code Quality |
| Prettier | Code Formatting |
| GitHub Actions | CI Automation |

## Architecture

The project follows a modular, feature-oriented architecture with clear separation of concerns.

Each module is responsible for a specific business capability, making the application easier to maintain, test, and extend.

The database design and ERD will be reviewed and documented before implementation.

## Getting Started

### Prerequisites

Make sure you have the following installed:

- Node.js (LTS)
- pnpm
- Docker and Docker Compose
- Git

### Installation

```bash
git clone https://github.com/YOUR_USERNAME/salesflow-api.git

cd salesflow-api

pnpm install
```

### Environment Variables

Create a local environment file:

```bash
cp .env.example .env
```

Configure the required environment variables before running the application.

### Running the Application

Development:

```bash
pnpm run start:dev
```

Build:

```bash
pnpm run build
```

*Setup commands may be updated as the project foundation is implemented.*

## Testing

The project will include:

- Unit Tests using Vitest.
- End-to-End API Tests using Vitest and Supertest.
- Database integration tests.

## API Documentation

Swagger / OpenAPI documentation will be available after the API foundation is implemented.

## Project Roadmap

- [ ] Architecture and Database ERD Design
- [ ] NestJS Project Setup
- [ ] PostgreSQL and Prisma Integration
- [ ] Redis and BullMQ Integration
- [ ] Authentication and Authorization
- [ ] Companies and Contacts Management
- [ ] Lead Management
- [ ] Lead Conversion
- [ ] Deals and Sales Pipeline
- [ ] Tasks and Activities
- [ ] Notifications
- [ ] CSV Import
- [ ] Reports and Analytics
- [ ] Unit and E2E Testing
- [ ] CI/CD Setup

## Development Principles

- Modular Architecture
- SOLID Principles
- Clean Code
- Separation of Concerns
- Secure API Design
- Database Integrity
- Testable Business Logic
- Scalable Background Processing

## License

This project is currently under development. License details will be added later.
