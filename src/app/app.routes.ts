import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/auth/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./shell/app-shell.component').then((m) => m.AppShellComponent),
    children: [
      {
        path: '',
        redirectTo: 'dashboard',
        pathMatch: 'full',
      },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./pages/dashboard/dashboard.page').then(
            (m) => m.DashboardPage,
          ),
      },
      {
        path: 'accounts',
        loadComponent: () =>
          import('./pages/accounts/account-list/account-list.page').then(
            (m) => m.AccountListPage,
          ),
      },
      {
        path: 'accounts/new',
        loadComponent: () =>
          import('./pages/accounts/account-form/account-form.page').then(
            (m) => m.AccountFormPage,
          ),
      },
      {
        path: 'accounts/:id',
        loadComponent: () =>
          import('./pages/accounts/account-detail/account-detail.page').then(
            (m) => m.AccountDetailPage,
          ),
      },
      {
        path: 'accounts/:id/edit',
        loadComponent: () =>
          import('./pages/accounts/account-form/account-form.page').then(
            (m) => m.AccountFormPage,
          ),
      },
      {
        path: 'transactions',
        loadComponent: () =>
          import(
            './pages/transactions/transaction-list/transaction-list.page'
          ).then((m) => m.TransactionListPage),
      },
      {
        path: 'transactions/new',
        loadComponent: () =>
          import(
            './pages/transactions/transaction-form/transaction-form.page'
          ).then((m) => m.TransactionFormPage),
      },
      {
        path: 'transactions/import',
        loadComponent: () =>
          import(
            './pages/transactions/transaction-import/transaction-import.page'
          ).then((m) => m.TransactionImportPage),
      },
      {
        path: 'transactions/:id/edit',
        loadComponent: () =>
          import(
            './pages/transactions/transaction-form/transaction-form.page'
          ).then((m) => m.TransactionFormPage),
      },
      {
        path: 'settlements/new',
        loadComponent: () =>
          import(
            './pages/settlements/settlement-form/settlement-form.page'
          ).then((m) => m.SettlementFormPage),
      },
      {
        path: 'categories',
        loadComponent: () =>
          import('./pages/categories/categories.page').then(
            (m) => m.CategoriesPage,
          ),
      },
      {
        path: 'calculator',
        loadComponent: () =>
          import('./pages/calculator/calculator.page').then(
            (m) => m.CalculatorPage,
          ),
      },
      {
        path: 'statistics',
        loadComponent: () =>
          import('./pages/statistics/statistics.page').then(
            (m) => m.StatisticsPage,
          ),
      },
      {
        path: 'profile',
        loadComponent: () =>
          import('./pages/profile/profile.page').then((m) => m.ProfilePage),
      },
    ],
  },
];
